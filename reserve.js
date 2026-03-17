import { getStore } from "@netlify/blobs";
import busboy from "busboy";

export const handler = async (event) => {
    // 사장님이 찾으신 Project ID와 토큰을 직접 꽂았습니다.
    const store = getStore({ 
        name: 'lumi_vault',
        siteID: "28d60e0e-6aa4-4b45-b117-0bcc3c4268fc", 
        token: "nfp_bqKqY4GBrd8MNNLxCiCssFhRN5qGfzWe82f7"
    });

    let fileData = null;
    let fileName = "";
    const fields = {};

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
            if (!fileData) return resolve({ statusCode: 400, body: "파일이 전송되지 않았습니다." });

            try {
                // 현재 시간과 파일명을 조합해 금고에 저장합니다.
                const key = `${Date.now()}_${fileName}`;
                await store.setRaw(key, fileData, { 
                    metadata: { 
                        user: fields.user || "Unknown",
                        originalName: fileName 
                    } 
                });
                resolve({ statusCode: 200, body: "Success" });
            } catch (err) {
                // 에러 발생 시 상세 내용을 화면에 띄웁니다.
                resolve({ statusCode: 500, body: "금고 저장 실패: " + err.message });
            }
        });

        bb.end(Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8'));
    });
};
