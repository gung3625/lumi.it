const { corsHeaders, getOrigin, verifyLumiSecret } = require('./_shared/auth');
// Background Function — 캡션 선택 후 Instagram 게시.
// 데이터 저장: public.reservations (Supabase).
// 토큰 조회: ig_accounts_decrypted 뷰 (service_role 전용) — 절대 로그/응답에 노출 금지.
// 이미지: reservations.image_urls (Supabase Storage public URL 권장).
const { createHmac } = require('crypto');
const { getAdminClient } = require('./_shared/supabase-admin');
const { deleteReservationStorage } = require('./_shared/storage-cleanup');
const { toProxyUrl } = require('./_shared/ig-image-url');


async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ─────────── Instagram Graph API 호출 헬퍼 ───────────
// Reels 인코딩 대기: 5초 × 24회 (최대 2분)
async function waitForContainer(containerId, accessToken, maxRetries = 6) {
  for (let i = 0; i < maxRetries; i++) {
    await sleep(5000);
    try {
      const res = await fetch(`https://graph.facebook.com/v25.0/${containerId}?fields=status_code&access_token=${accessToken}`);
      const data = await res.json();
      if (data.status_code === 'FINISHED') return true;
      if (data.status_code === 'ERROR') return false;
    } catch (e) { /* 다음 retry */ }
  }
  return true;
}

async function createMediaContainer(igUserId, igAccessToken, imageUrl, isCarousel) {
  const params = new URLSearchParams({ image_url: imageUrl, access_token: igAccessToken });
  if (isCarousel) params.set('is_carousel_item', 'true');
  const res = await fetch(`https://graph.facebook.com/v25.0/${igUserId}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  const data = await res.json();
  if (data.error) throw new Error(`IG container error: ${data.error.message || 'unknown'}`);
  return data.id;
}

async function publishMedia(igUserId, igAccessToken, creationId) {
  const res = await fetch(`https://graph.facebook.com/v25.0/${igUserId}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ creation_id: creationId, access_token: igAccessToken }),
  });
  return res.json();
}

async function postToInstagram({ igUserId, igAccessToken, igUserAccessToken, storyEnabled, mediaType, videoUrl }, caption, imageUrls) {
  if (!igUserId || !igAccessToken) throw new Error('Instagram 연동 정보 없음');
  // IG crawler가 Supabase 도메인 fetch 못하므로 lumi.it.kr 프록시 URL로 변환
  imageUrls = Array.isArray(imageUrls) ? imageUrls.map(toProxyUrl) : imageUrls;
  let postId;

  // REELS 게시 (영상) — IMAGE 경로와 분리된 분기
  if (mediaType === 'REELS') {
    if (!videoUrl) throw new Error('Reels 영상 URL 없음');
    const params = new URLSearchParams({
      media_type: 'REELS',
      video_url: videoUrl,
      caption,
      access_token: igAccessToken,
    });
    const res = await fetch(`https://graph.facebook.com/v25.0/${igUserId}/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });
    const d = await res.json();
    if (d.error) throw new Error(d.error.message || 'Reels 컨테이너 생성 실패');
    const ready = await waitForContainer(d.id, igAccessToken, 24);
    if (!ready) throw new Error('Reels 컨테이너 처리 시간 초과');
    const pData = await publishMedia(igUserId, igAccessToken, d.id);
    if (pData.error) throw new Error(pData.error.message || 'Reels 컨테이너 생성 실패');
    postId = pData.id;

    // 영상 스토리 게시 (storyEnabled + videoUrl 모두 있을 때)
    if (storyEnabled && videoUrl) {
      try {
        const storyToken = igUserAccessToken || igAccessToken;
        await sleep(3000);
        const sRes = await fetch(`https://graph.facebook.com/v25.0/${igUserId}/media`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ media_type: 'STORIES', video_url: videoUrl, access_token: storyToken }),
        });
        const sData = await sRes.json();
        if (sData.error) {
          console.error('[select-and-post] REELS 스토리 컨테이너 생성 실패');
        } else {
          await waitForContainer(sData.id, storyToken);
          await publishMedia(igUserId, storyToken, sData.id);
          console.log('[select-and-post] REELS 스토리 게시 완료');
        }
      } catch (e) { console.error('[select-and-post] REELS 스토리 예외:', e.message); }
    }
    return postId;
  }

  if (imageUrls.length > 1) {
    const containerIds = await Promise.all(imageUrls.map((url) => createMediaContainer(igUserId, igAccessToken, url, true)));
    const cRes = await fetch(`https://graph.facebook.com/v25.0/${igUserId}/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        media_type: 'CAROUSEL',
        children: containerIds.join(','),
        caption,
        access_token: igAccessToken,
      }),
    });
    const cData = await cRes.json();
    if (cData.error) throw new Error(cData.error.message);
    await waitForContainer(cData.id, igAccessToken);
    const pData = await publishMedia(igUserId, igAccessToken, cData.id);
    if (pData.error) throw new Error(pData.error.message);
    postId = pData.id;
  } else {
    const res = await fetch(`https://graph.facebook.com/v25.0/${igUserId}/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ image_url: imageUrls[0], media_type: 'IMAGE', caption, access_token: igAccessToken }),
    });
    const d = await res.json();
    if (d.error) throw new Error(d.error.message);
    await waitForContainer(d.id, igAccessToken);
    const pData = await publishMedia(igUserId, igAccessToken, d.id);
    if (pData.error) throw new Error(pData.error.message);
    postId = pData.id;
  }

  // 스토리 — 유저 액세스 토큰만 사용 (pageAccessToken 은 스토리 권한 없음)
  if (storyEnabled && imageUrls[0]) {
    try {
      const storyToken = igUserAccessToken || igAccessToken;
      await sleep(3000);
      const sRes = await fetch(`https://graph.facebook.com/v25.0/${igUserId}/media`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ image_url: imageUrls[0], media_type: 'STORIES', access_token: storyToken }),
      });
      const sData = await sRes.json();
      if (sData.error) {
        console.error('[select-and-post] 스토리 컨테이너 생성 실패');
      } else {
        await waitForContainer(sData.id, storyToken);
        await publishMedia(igUserId, storyToken, sData.id);
        console.log('[select-and-post] 스토리 게시 완료');
      }
    } catch (e) { console.error('[select-and-post] 스토리 예외:', e.message); }
  }

  return postId;
}

async function postToThreads(caption, imageUrl, videoUrl) {
  const userId = process.env.THREADS_USER_ID;
  const token = process.env.THREADS_ACCESS_TOKEN;
  if (!userId || !token) throw new Error('Threads 환경변수 없음');

  const body = videoUrl
    ? { media_type: 'VIDEO', video_url: videoUrl, text: caption, access_token: token }
    : { media_type: 'IMAGE', image_url: imageUrl, text: caption, access_token: token };

  const createRes = await fetch(`https://graph.threads.net/v1.0/${userId}/threads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const createData = await createRes.json();
  if (createData.error) throw new Error(`Threads container error: ${createData.error.message || 'unknown'}`);
  const creationId = createData.id;

  await sleep(30000);

  const pubRes = await fetch(`https://graph.threads.net/v1.0/${userId}/threads_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ creation_id: creationId, access_token: token }),
  });
  return pubRes.json();
}

async function sendAlimtalk(phone, text) {
  try {
    const now = new Date().toISOString();
    const salt = `post_${Date.now()}`;
    const sig = createHmac('sha256', process.env.SOLAPI_API_SECRET).update(`${now}${salt}`).digest('hex');
    await fetch('https://api.solapi.com/messages/v4/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `HMAC-SHA256 ApiKey=${process.env.SOLAPI_API_KEY}, Date=${now}, Salt=${salt}, Signature=${sig}`,
      },
      body: JSON.stringify({ message: { to: phone, from: '01064246284', text } }),
    });
  } catch (e) { console.error('[select-and-post] 알림톡 실패:', e.message); }
}

async function saveCaptionHistory(supabase, userId, caption) {
  try {
    await supabase.from('caption_history').insert({
      user_id: userId,
      caption: caption.trim(),
      caption_type: 'posted',
    });
  } catch (e) { console.error('[select-and-post] 캡션 히스토리 저장 실패:', e.message); }
}

exports.handler = async (event) => {
  const headers = corsHeaders(getOrigin(event));
  // 내부 호출 인증
  const authHeader = (event.headers['authorization'] || '');
  if (!verifyLumiSecret(authHeader)) {
    console.error('[select-and-post] 인증 실패');
    return { statusCode: 401 };
  }

  const supabase = getAdminClient();
  let reservationKey = null;

  try {
    const body = JSON.parse(event.body || '{}');
    reservationKey = body.reservationKey;
    const captionIndex = Number(body.captionIndex);
    if (!reservationKey) return;

    // 1) reservation 조회
    const { data: reservation, error: resErr } = await supabase
      .from('reservations')
      .select('*')
      .eq('reserve_key', reservationKey)
      .maybeSingle();
    if (resErr || !reservation) {
      console.error('[select-and-post] 예약 조회 실패:', resErr?.message || 'not found');
      return;
    }
    if (reservation.is_sent) { console.log('[select-and-post] 이미 게시됨'); return; }

    // 2) 중복 호출 방지 — posting 상태로 선 마킹
    if (reservation.caption_status !== 'posting') {
      await supabase
        .from('reservations')
        .update({ caption_status: 'posting' })
        .eq('reserve_key', reservationKey);
    }

    const captions = reservation.generated_captions || reservation.captions || [];
    let selectedCaption = Array.isArray(captions) ? captions[captionIndex] : null;
    if (!selectedCaption) { console.error('[select-and-post] 캡션 없음'); return; }

    // 링크인바이오 자동 삽입 — feat_toggles.linkinbio=true + link_pages.slug 존재 시
    try {
      const { data: userRow } = await supabase
        .from('users')
        .select('feat_toggles')
        .eq('id', reservation.user_id)
        .maybeSingle();
      const ft = (userRow && userRow.feat_toggles) || {};
      if (ft.linkinbio === true) {
        const { data: linkPageRow } = await supabase
          .from('link_pages')
          .select('slug')
          .eq('user_id', reservation.user_id)
          .maybeSingle();
        const slug = linkPageRow && linkPageRow.slug;
        if (slug && !selectedCaption.includes('lumi.it.kr/p/')) {
          selectedCaption = selectedCaption + '\n\nhttps://lumi.it.kr/p/' + slug;
          console.log('[select-and-post] 링크인바이오 URL 삽입 완료');
        }
      }
    } catch (libErr) {
      console.warn('[select-and-post] 링크인바이오 삽입 스킵:', libErr.message);
    }

    const imageUrls = Array.isArray(reservation.image_urls) ? reservation.image_urls : [];
    const mediaType = reservation.media_type || 'IMAGE';
    if (mediaType === 'REELS') {
      if (!reservation.video_url) {
        console.error('[select-and-post] 영상 URL 없음');
        await supabase.from('reservations').update({
          caption_status: 'failed',
          caption_error: '영상 URL을 찾을 수 없습니다.',
        }).eq('reserve_key', reservationKey);
        return;
      }
    } else if (!imageUrls.length) {
      console.error('[select-and-post] 이미지 없음'); return;
    }

    // 3) IG 토큰 조회 (Vault 복호화 뷰, service_role 전용)
    const { data: igRow, error: igErr } = await supabase
      .from('ig_accounts_decrypted')
      .select('ig_user_id, access_token, page_access_token')
      .eq('user_id', reservation.user_id)
      .maybeSingle();
    if (igErr || !igRow || !igRow.access_token) {
      console.error('[select-and-post] IG 토큰 조회 실패');
      await supabase.from('reservations').update({
        caption_status: 'failed',
        caption_error: 'Instagram 연동 정보를 찾을 수 없습니다.',
      }).eq('reserve_key', reservationKey);
      return;
    }

    const igUserId = igRow.ig_user_id;
    const igUserAccessToken = igRow.access_token;
    const igAccessToken = igRow.page_access_token || igRow.access_token;

    console.log(`[select-and-post] 게시 시작: ${reservationKey}, captionIndex=${captionIndex}`);

    // 4) Instagram 게시
    const postId = await postToInstagram(
      {
        igUserId,
        igAccessToken,
        igUserAccessToken,
        storyEnabled: reservation.story_enabled,
        mediaType,
        videoUrl: reservation.video_url,
      },
      selectedCaption,
      imageUrls
    );
    console.log('[select-and-post] Instagram 게시 완료:', postId);

    // 5) Threads 게시 (옵션)
    let threadsUpdate = {};
    if (reservation.post_to_thread && (imageUrls[0] || mediaType === 'REELS')) {
      let threadsStatus = 'failed';
      let threadsError = null;
      let threadsPostId = null;
      try {
        console.log('[select-and-post] Threads 게시 시작');
        const threadsResult = mediaType === 'REELS'
          ? await postToThreads(selectedCaption, null, reservation.video_url)
          : await postToThreads(selectedCaption, imageUrls[0]);
        if (threadsResult.error) {
          threadsError = threadsResult.error.message || 'threads error';
          if (threadsResult.error.code === 190) threadsStatus = 'token_expired';
          console.error('[select-and-post] Threads 게시 실패');
        } else {
          threadsStatus = 'ok';
          threadsPostId = threadsResult.id || null;
          console.log('[select-and-post] Threads 게시 완료:', threadsPostId);
        }
      } catch (te) {
        threadsError = te.message || String(te);
        if (/code":\s*190|expired|invalid.*token/i.test(threadsError)) threadsStatus = 'token_expired';
        console.error('[select-and-post] Threads 예외');
      }
      threadsUpdate = {
        // reservations 테이블에는 threads 전용 컬럼이 없음 — 현재 스키마 유지 범위에서는 로그만.
      };
      if (threadsStatus === 'token_expired') {
        try {
          await sendAlimtalk(
            '01064246284',
            '[lumi] 스레드 토큰 만료\n\n스레드 게시가 실패했어요.\n대시보드 설정에서 스레드 재연동이 필요합니다.\n\n예약: ' + reservationKey
          );
        } catch (_) { /* noop */ }
      }
    }

    // 6) 예약 상태 업데이트 (posted)
    const postedAt = new Date().toISOString();
    const { error: updErr } = await supabase
      .from('reservations')
      .update({
        is_sent: true,
        caption_status: 'posted',
        selected_caption_index: captionIndex,
        ig_post_id: String(postId),
        posted_at: postedAt,
      })
      .eq('reserve_key', reservationKey);
    if (updErr) console.error('[select-and-post] 예약 업데이트 실패:', updErr.message);

    // 6-0) Instagram CDN URL 역조회 — Supabase Storage URL 대신 IG CDN URL로 교체
    // 스토리지 정리 전에 실행해야 이후 대시보드에서 사진/영상이 보임
    try {
      const igCtrl = new AbortController();
      const igTid = setTimeout(() => igCtrl.abort(), 10000);
      let igMediaRes;
      try {
        igMediaRes = await fetch(
          `https://graph.facebook.com/v25.0/${postId}?fields=media_type,media_url,thumbnail_url,children{media_url,thumbnail_url}&access_token=${igAccessToken}`,
          { signal: igCtrl.signal }
        );
      } finally {
        clearTimeout(igTid);
      }
      if (igMediaRes.ok) {
        const igMedia = await igMediaRes.json();
        if (!igMedia.error) {
          const mt = igMedia.media_type;
          const cdnUpdate = {};
          if (mt === 'CAROUSEL_ALBUM' && igMedia.children && igMedia.children.data) {
            cdnUpdate.image_urls = igMedia.children.data.map((c) => c.media_url).filter(Boolean);
          } else if (mt === 'IMAGE') {
            if (igMedia.media_url) cdnUpdate.image_urls = [igMedia.media_url];
          } else if (mt === 'VIDEO' || mt === 'REELS') {
            const cdnUrl = igMedia.media_url || igMedia.thumbnail_url;
            if (cdnUrl) cdnUpdate.image_urls = [cdnUrl];
            if (igMedia.media_url) cdnUpdate.video_url = igMedia.media_url;
          }
          if (Object.keys(cdnUpdate).length) {
            const { error: cdnErr } = await supabase
              .from('reservations')
              .update(cdnUpdate)
              .eq('reserve_key', reservationKey);
            if (cdnErr) console.error('[select-and-post] CDN URL 저장 실패:', cdnErr.message);
            else console.log('[select-and-post] IG CDN URL 교체 완료 media_type=' + mt);
          }
        } else {
          console.warn('[select-and-post] IG media 조회 API 오류:', igMedia.error.message);
        }
      } else {
        console.warn('[select-and-post] IG media 조회 HTTP 오류:', igMediaRes.status);
      }
    } catch (cdnErr) {
      console.warn('[select-and-post] IG CDN URL 조회 예외(무시):', cdnErr.message);
    }

    // 6-1) 게시 완료 후 스토리지 정리 — row는 히스토리 용도로 유지
    // 실패는 게시 성공 상태에 영향을 주지 않음
    if (!updErr) {
      try {
        const cleanup = await deleteReservationStorage(supabase, reservation);
        console.log(
          `[select-and-post] 게시 후 스토리지 정리: images=${cleanup.imagesDeleted} video=${cleanup.videoDeleted} errors=${cleanup.errors.length}`
        );
        if (cleanup.errors.length) {
          console.warn('[select-and-post] 스토리지 정리 경고:', cleanup.errors.join(' | '));
        }
        // row에서 keys 컬럼 비우기 — 중복 삭제 방지
        await supabase
          .from('reservations')
          .update({ image_keys: [], video_key: null })
          .eq('reserve_key', reservationKey);
      } catch (cleanErr) {
        console.error('[select-and-post] 스토리지 정리 예외:', cleanErr.message);
      }
    }

    // 7) 캡션 히스토리 저장
    if (reservation.user_id) await saveCaptionHistory(supabase, reservation.user_id, selectedCaption);

    // 8) 완료 알림톡 (storeProfile 에서 phone + 매장명 추출)
    const sp = reservation.store_profile || {};
    const phone = sp.phone || sp.ownerPhone;
    if (phone) {
      await sendAlimtalk(
        phone,
        `[lumi] 인스타그램에 게시됐어요! 📸\n\n${sp.name || '매장'} 게시물이 올라갔어요.\n인스타그램에서 확인해보세요!`
      );
    }

  } catch (err) {
    console.error('[select-and-post] 에러:', err.message);
    if (reservationKey) {
      try {
        await supabase
          .from('reservations')
          .update({
            caption_status: 'failed',
            caption_error: err.message || '게시 중 오류가 발생했습니다.',
          })
          .eq('reserve_key', reservationKey);
      } catch (_) { /* noop */ }
    }
  }
};

// 프론트 호환: 일부 호출자는 import 형태로 headers 참조. 안전하게 export.
exports.headers = headers;
