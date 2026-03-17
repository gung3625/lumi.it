import { getStore } from "@netlify/blobs";
import fetch from "node-fetch";

export const handler = async (event) => {
    const store = getStore({ 
        name: 'lumi_vault',
        siteID: "28d60e0e-6aa4-4b45-b117-0bcc3c4268fc", 
        token: "nfp_bqKqY4GBrd8MNNLxCiCssFhRN5qGfzWe82f7"
    });

    const MAKE_WEBHOOK_URL = "https://hook.eu1.make.com/pbs5m4kgrhifsyk9wvjp1duyhjovayet";

    try {
        const list = await store.list();
        const now = new Date();

        for (const blob of list.blobs) {
            const entry = await store.getMetadata(blob.key);
            if (!entry || entry.metadata.isSent) continue; // 이미 보냈다면 패스

            const resDateTime = new Date(`${entry.metadata.resDate} ${entry.metadata.resTime}`);

            // 예약 시간이 현재 시간보다 과거라면 (즉, 보낼 시간이 되었다면)
            if (resDateTime <= now) {
                const fileData = await store.get(blob.key, { type: "blob" });
                const base64Data = Buffer.from(await fileData.arrayBuffer()).toString('base64');

                // Make 웹훅으로 전송
                await fetch(MAKE_WEBHOOK_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        ...entry.metadata,
                        imageData: base64Data
                    })
                });

                // 전송 완료 표시 (isSent 처리 또는 데이터 삭제)
                await store.setMetadata(blob.key, { ...entry.metadata, isSent: true });
            }
        }
        return { statusCode: 200 };
    } catch (err) {
        return { statusCode: 500, body: err.message };
    }
};

// Netlify 스케줄 설정 (매 1분마다 실행)
export const config = {
    schedule: "* * * * *"
};
