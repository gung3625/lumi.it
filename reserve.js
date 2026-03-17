import { getStore } from "@netlify/blobs";
import busboy from "busboy";
import fetch from "node-fetch"; // 웹훅 전송을 위해 필요

export const handler = async (event) => {
    const store = getStore({ 
        name: 'lumi_vault',
        siteID: "28d60e0e-6aa4-4b45-b117-0bcc3c4268fc", 
        token: "nfp_bqKqY4GBrd8MNNLxCiCssFhRN5qGfzWe82f7"
    });

    const MAKE_WEBHOOK_URL = "https://hook.eu1.make.com/pbs5m4kgrhifsyk9wvjp1duyhjovayet";
    const headers = event.headers;
    const isBase64Encoded = event.isBase64Encoded;
    const bodyBuffer = Buffer.from(event.body, isBase64Encoded ? 'base64' : 'utf8');

    return new Promise((resolve) => {
        const bb = busboy({ headers });
        const fields = {};
        let fileData = null;
        let fileName = "";

        bb.on('file', (name, file, info) => {
            fileName = info.filename;
            const chunks = [];
            file.on('data', (d) => chunks.push(d));
            file.on('end', () => { fileData = Buffer.concat(chunks); });
        });

        bb.on('field', (name, val) => { fields[name] = val; });

        bb.on('finish', async () => {
            if (!fileData) return resolve({ statusCode: 400, body: "파일 없음" });

            try {
                const key = `${fields.resDate || '0000'}_${Date.now()}`;
                const metadata = { 
                    userName: fields.userName,
                    userPhone: fields.userPhone,
                    resDate: fields.resDate,
                    resTime: fields.resTime,
                    originalFileName: fileName
                };

                // 1. Netlify Blobs(금고)에 저장
                await store.set(key, fileData, { metadata });

                // 2. Make.com 웹훅으로 데이터 전송 (즉시 전송)
                // 이미지는 Base64로 인코딩하여 텍스트 형태로 보냅니다.
                await fetch(MAKE_WEBHOOK_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        ...metadata,
                        imageInfo: key,
                        imageData: fileData.toString('base64') // 이미지 바이너리를 텍스트화
                    })
                });

                resolve({ 
                    statusCode: 200, 
                    headers: { "Access-Control-Allow-Origin": "*" },
                    body: JSON.stringify({ message: "금고 저장 및 웹훅 전송 성공", key }) 
                });
            } catch (err) {
                resolve({ statusCode: 500, body: "오류 발생: " + err.message });
            }
        });

        bb.end(bodyBuffer);
    });
};
