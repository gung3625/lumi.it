import { getStore } from "@netlify/blobs";
import busboy from "busboy";

export const handler = async (event) => {
    // 1. 금고 설정 (사장님 전용 열쇠)
    const store = getStore({ 
        name: 'lumi_vault',
        siteID: "28d60e0e-6aa4-4b45-b117-0bcc3c4268fc", 
        token: "nfp_bqKqY4GBrd8MNNLxCiCssFhRN5qGfzWe82f7"
    });

    // 2. 헤더 대문자/소문자 문제 해결
    const headers = {};
    for (const [key, value] of Object.entries(event.headers)) {
        headers[key.toLowerCase()] = value;
    }

    // 3. Content-Type이 없으면 실행하지 않고 돌려보내기
    if (!headers['content-type']) {
        return { 
            statusCode: 400, 
            body: "잘못된 접근입니다. (파일을 선택한 뒤 '사진 전송' 버튼을 눌러주세요!)" 
        };
    }

    let fileData = null;
    let fileName = "";
    const fields = {};

    return new Promise((resolve) => {
        try {
            const bb = busboy({ headers });

            bb.on('file', (name, file, info) => {
                fileName = info.filename;
                const chunks = [];
                file.on('data', (d) => chunks.push(d));
                file.on('end', () => { fileData = Buffer.concat(chunks); });
            });

            bb.on('field', (name, val) => { fields[name] = val; });

            bb.on('finish', async () => {
                if (!fileData) return resolve({ statusCode: 400, body: "파일 데이터가 비어있습니다." });

                try {
                    const key = `${Date.now()}_${fileName}`;
                    // .setRaw 대신 최신 .set() 사용
                    await store.set(key, fileData, { 
                        metadata: { user: fields.user || "Unknown" } 
                    });
                    resolve({ statusCode: 200, body: "Success" });
                } catch (err) {
                    resolve({ statusCode: 500, body: "금고 저장 에러: " + err.message });
                }
            });

            bb.end(Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8'));
        } catch (e) {
            resolve({ statusCode: 500, body: "내부 처리 에러: " + e.message });
        }
    });
};
