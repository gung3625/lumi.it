import { getStore } from "@netlify/blobs";
import busboy from "busboy";

export const handler = async (event) => {
    // Netlify 대시보드에서 Blobs를 활성화했다면 키 없이도 작동합니다.
    const store = getStore({ name: 'lumi_vault' });
    const fields = {};
    let fileData = null;
    let fileName = "";

    return new Promise((resolve) => {
        const bb = busboy({ headers: event.headers });

        bb.on('file', (name, file, info) => {
            fileName = info.filename;
            const chunks = [];
            file.on('data', (d) => chunks.push(d));
            file.on('end', () => { fileData = Buffer.concat(chunks); });
        });

        bb.on('field', (name, val) => { fields[name] = val; });

        bb.on('finish', async () => {
            if (!fileData) return resolve({ statusCode: 400, body: "파일이 없습니다." });

            try {
                // 사진을 금고에 저장 (이름은 현재시간으로)
                const key = `${Date.now()}_${fileName}`;
                await store.setRaw(key, fileData, { 
                    metadata: { user: fields.user || "Unknown" } 
                });
                resolve({ statusCode: 200, body: "Success" });
            } catch (err) {
                resolve({ statusCode: 500, body: "Vault Error: " + err.message });
            }
        });

        bb.end(Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8'));
    });
};
