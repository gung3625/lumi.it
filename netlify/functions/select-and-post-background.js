const { corsHeaders, getOrigin, verifyLumiSecret } = require('./_shared/auth');
// Background Function — 캡션 선택 후 Instagram 게시.
// 데이터 저장: public.reservations (Supabase).
// 토큰 조회: ig_accounts_decrypted 뷰 (service_role 전용) — 절대 로그/응답에 노출 금지.
// 이미지: reservations.image_urls (Supabase Storage public URL 권장).
const { createHmac } = require('crypto');
const { getAdminClient } = require('./_shared/supabase-admin');
const { deleteReservationStorage } = require('./_shared/storage-cleanup');
// IG 게시 헬퍼는 retry-channel-post 와 공유 위해 _shared/ig-publish.js 로 추출.
const { postToInstagram } = require('./_shared/ig-publish');
const {
  getThreadsTokenForSeller,
  createThreadsContainer,
  waitForThreadsContainer,
  publishThreadsContainer,
  markThreadsTokenInvalid,
  ThreadsGraphError,
} = require('./_shared/threads-graph');


async function postToThreadsForSeller(supabase, sellerId, caption, imageUrl, videoUrl) {
  // M2.1 — 글로벌 env 토큰(THREADS_USER_ID/ACCESS_TOKEN) 대신 사장님별 OAuth 토큰 사용.
  // 1단계: ig_accounts_decrypted 뷰에서 threads_user_id + threads_token 조회
  // 2단계: createThreadsContainer (POST /{user-id}/threads) → creation_id
  // 3단계: waitForThreadsContainer 폴링 (status='FINISHED' 대기) → publishThreadsContainer
  // 실패 시 ThreadsGraphError 던짐. isTokenExpired() true 면 호출 측이 markThreadsTokenInvalid.
  const cred = await getThreadsTokenForSeller(sellerId, supabase);
  if (!cred) throw new ThreadsGraphError('Threads 미연동 또는 토큰 없음', { status: 0 });

  const { threadsUserId, accessToken } = cred;
  const mediaType = videoUrl ? 'VIDEO' : 'IMAGE';
  const created = await createThreadsContainer({
    token: accessToken,
    threadsUserId,
    mediaType,
    imageUrl: videoUrl ? null : imageUrl,
    videoUrl: videoUrl || null,
    text: caption,
  }, { timeoutMs: 60000 });
  if (!created || !created.id) throw new ThreadsGraphError('Threads 컨테이너 생성 응답에 id 없음');

  await waitForThreadsContainer({ token: accessToken, creationId: created.id });

  const published = await publishThreadsContainer({
    token: accessToken,
    threadsUserId,
    creationId: created.id,
  }, { timeoutMs: 60000 });
  if (!published || !published.id) throw new ThreadsGraphError('Threads publish 응답에 id 없음');
  return published.id;
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
  let userIdForTokenMark = null;   // catch 블록에서 IG 토큰 만료 마킹용
  let reservationIdForChannelMark = null;  // catch 블록에서 channel_posts(ig, failed) 마킹용
  let igAttempted = false;          // postToInstagram 호출 시점부터 true → catch 에서 IG 실패만 마킹

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
    userIdForTokenMark = reservation.user_id;

    // REELS gate: 후처리 미완료면 보류. process-video 가 완료 시 자신이 다시 트리거하거나
    // scheduler 가 다음 cycle 에서 픽업하므로 안전하게 return 만 한다.
    // (원본 .mov 가 그대로 Meta 로 업로드되어 overlay/자막 누락되는 사고 방지)
    if ((reservation.media_type || 'IMAGE') === 'REELS' && !reservation.video_processed_at) {
      console.log('[select-and-post] REELS 후처리 미완료 — 보류:', reservationKey);
      return;
    }

    // 2) 중복 호출 방지 — atomic CAS 로 'scheduled' → 'posting' 전이.
    //    동일 row 에 대해 process-and-post 직접 트리거 + scheduler cron 트리거 가
    //    동시에 select-and-post 를 호출하던 race 가 여기서 차단된다.
    //    Postgres 가 row lock 안에서 WHERE 재검사하므로 오직 한 호출만 affected rows>0 을 받음.
    //    이전엔 select-then-update 패턴이라 둘 다 통과 → 동일 사진 N개 게시되는 버그 발생.
    {
      const { data: claimed, error: claimErr } = await supabase
        .from('reservations')
        .update({ caption_status: 'posting' })
        .eq('reserve_key', reservationKey)
        .eq('caption_status', 'scheduled')
        .eq('is_sent', false)
        .select('reserve_key');
      if (claimErr) {
        console.error('[select-and-post] claim 실패:', claimErr.message);
        return;
      }
      if (!claimed || claimed.length === 0) {
        console.log('[select-and-post] 다른 호출이 이미 진행 중/완료 — 스킵:', reservationKey);
        return;
      }
    }

    const captions = reservation.generated_captions || reservation.captions || [];
    let selectedCaption = Array.isArray(captions) ? captions[captionIndex] : null;
    if (!selectedCaption) { console.error('[select-and-post] 캡션 없음'); return; }

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

    // 4) Instagram 게시 — catch 블록의 IG 실패 마킹 가드용 플래그·id 노출
    reservationIdForChannelMark = reservation.id;
    igAttempted = true;
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

    // 4-1) channel_posts 에 IG 성공 row 기록 (결정 §12-A #6, #7)
    //      - PK (reservation_id, channel) 충돌 시 upsert 로 멱등 처리.
    //      - credit_consumed=true 가 성공 채널 차감 source of truth.
    //      - IG 게시는 reservations.ig_post_id 도 그대로 유지 (M2.1 추가만, 제거 X).
    try {
      const postedAtIso = new Date().toISOString();
      const { error: cpIgErr } = await supabase
        .from('channel_posts')
        .upsert({
          reservation_id: reservation.id,
          channel: 'ig',
          status: 'posted',
          post_id: String(postId),
          posted_at: postedAtIso,
          credit_consumed: true,
        }, { onConflict: 'reservation_id,channel' });
      if (cpIgErr) console.warn('[select-and-post] channel_posts(ig) upsert 경고:', cpIgErr.message);
    } catch (e) {
      console.warn('[select-and-post] channel_posts(ig) 예외 (무시):', e && e.message);
    }

    // 5) Threads 게시 (옵션) — M2.1 부터 per-seller OAuth 토큰 사용
    if (reservation.post_to_thread && (imageUrls[0] || mediaType === 'REELS')) {
      let threadsStatus  = 'failed';
      let threadsErrMsg  = null;
      let threadsPostId  = null;
      let tokenExpired   = false;

      // 5-0) channel_posts(threads, posting) 선마킹 — race 차단 + UI 가시성
      try {
        await supabase.from('channel_posts').upsert({
          reservation_id: reservation.id,
          channel: 'threads',
          status: 'posting',
          credit_consumed: false,
        }, { onConflict: 'reservation_id,channel' });
      } catch (e) {
        console.warn('[select-and-post] channel_posts(threads pending) 경고:', e && e.message);
      }

      try {
        console.log('[select-and-post] Threads 게시 시작 (per-seller token)');
        // M2.2 — Threads 전용 캡션 (결정 §12-A #4) 우선, 없으면 IG 캡션 fallback
        const threadsCaption = (reservation.generated_threads_caption && String(reservation.generated_threads_caption).trim())
          || selectedCaption;
        threadsPostId = mediaType === 'REELS'
          ? await postToThreadsForSeller(supabase, reservation.user_id, threadsCaption, null, reservation.video_url)
          : await postToThreadsForSeller(supabase, reservation.user_id, threadsCaption, imageUrls[0], null);
        threadsStatus = 'posted';
        console.log('[select-and-post] Threads 게시 완료:', threadsPostId);
      } catch (te) {
        threadsErrMsg = te && te.message ? te.message : String(te);
        tokenExpired = (te instanceof ThreadsGraphError && te.isTokenExpired()) ||
                       /code":\s*190|expired|invalid.*token/i.test(threadsErrMsg);
        console.error('[select-and-post] Threads 게시 실패:', threadsErrMsg);
      }

      // 5-1) channel_posts(threads) 최종 상태 반영 (결정 §12-A #7 — 성공 시에만 credit_consumed=true)
      try {
        const patch = threadsStatus === 'posted'
          ? { status: 'posted', post_id: threadsPostId ? String(threadsPostId) : null, posted_at: new Date().toISOString(), credit_consumed: true, error_message: null }
          : { status: 'failed', error_message: (threadsErrMsg || 'unknown').slice(0, 500), credit_consumed: false };
        const { error: cpThErr } = await supabase
          .from('channel_posts')
          .upsert({
            reservation_id: reservation.id,
            channel: 'threads',
            ...patch,
          }, { onConflict: 'reservation_id,channel' });
        if (cpThErr) console.warn('[select-and-post] channel_posts(threads final) 경고:', cpThErr.message);
      } catch (e) {
        console.warn('[select-and-post] channel_posts(threads final) 예외 (무시):', e && e.message);
      }

      // 5-2) 토큰 만료 마킹 + 알림톡
      if (tokenExpired) {
        try { await markThreadsTokenInvalid(supabase, reservation.user_id, 'select-and-post'); } catch (_) { /* noop */ }
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

    // 6-1) seller_post_history append — 베스트 시간 개인화용 통합 이력.
    //      (가입 전 백필분 + Lumi 게시분 한 테이블. media_type 은 IG CDN 역조회 단계에서 update.)
    //      실패해도 게시 흐름엔 영향 없음 — warn 만.
    if (reservation.user_id) {
      try {
        const { error: histErr } = await supabase
          .from('seller_post_history')
          .upsert({
            user_id: reservation.user_id,
            ig_media_id: String(postId),
            posted_at: postedAt,
            source: 'lumi',
          }, { onConflict: 'user_id,ig_media_id', ignoreDuplicates: true });
        if (histErr) console.warn('[select-and-post] seller_post_history upsert 경고:', histErr.message);
      } catch (e) {
        console.warn('[select-and-post] seller_post_history 예외 (무시):', e && e.message);
      }
    }

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
          // seller_post_history 의 media_type 보강 (위 6-1에서 null 로 들어간 row)
          if (mt && reservation.user_id) {
            const { error: histMtErr } = await supabase
              .from('seller_post_history')
              .update({ media_type: mt })
              .eq('user_id', reservation.user_id)
              .eq('ig_media_id', String(postId));
            if (histMtErr) console.warn('[select-and-post] seller_post_history media_type update 경고:', histMtErr.message);
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
    // IG 토큰 만료 패턴 감지 — postToInstagram 이 d.error.message 만 throw 하므로
    // Graph 표준 표현(code 190 / OAuthException / "session has expired" / "Invalid OAuth access token") 으로 매칭.
    const msg = String(err && err.message || '');
    const isIgTokenExpired =
      /code["']?\s*:\s*190/i.test(msg) ||
      /OAuthException/i.test(msg) ||
      /session has expired/i.test(msg) ||
      /access token.*(expired|invalid)/i.test(msg) ||
      /Invalid OAuth/i.test(msg);

    // 토큰 만료면 ig_accounts.token_invalid_at 마킹 → 대시보드 배너·comments/insight 사전 차단 활성화.
    if (isIgTokenExpired && userIdForTokenMark) {
      try {
        await supabase
          .from('ig_accounts')
          .update({ token_invalid_at: new Date().toISOString() })
          .eq('user_id', userIdForTokenMark);
        console.log('[select-and-post] token_invalid_at 마킹:', userIdForTokenMark);
      } catch (e) {
        console.warn('[select-and-post] token_invalid_at 마킹 실패:', e.message);
      }
    }

    if (reservationKey) {
      try {
        await supabase
          .from('reservations')
          .update({
            caption_status: 'failed',
            caption_error: isIgTokenExpired
              ? 'IG 토큰이 만료됐어요. 설정 → 인스타 재연동 후 다시 게시해주세요.'
              : (err.message || '게시 중 오류가 발생했습니다.'),
          })
          .eq('reserve_key', reservationKey);
      } catch (_) { /* noop */ }
    }

    // 코드 리뷰 #1 — IG 실패 시 channel_posts(ig, failed) 마킹.
    // postToInstagram 호출 시점부터 igAttempted=true 라 IG attempt 였음을 보장.
    // history.html 의 채널 칩에 IG 실패가 정상 표시되도록.
    if (igAttempted && reservationIdForChannelMark) {
      try {
        await supabase
          .from('channel_posts')
          .upsert({
            reservation_id: reservationIdForChannelMark,
            channel: 'ig',
            status: 'failed',
            error_message: String(err && err.message || 'unknown').slice(0, 500),
            credit_consumed: false,
          }, { onConflict: 'reservation_id,channel' });
      } catch (e) {
        console.warn('[select-and-post] channel_posts(ig, failed) 마킹 실패 (무시):', e && e.message);
      }
    }
  }
};

