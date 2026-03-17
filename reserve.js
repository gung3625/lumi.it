import { getStore } from "@netlify/blobs";
import busboy from "busboy";

export const handler = async (event) => {
    const store = getStore({ 
        name: 'lumi_vault',
        siteID: "28d60e0e-6aa4-4b45-b117-0bcc3c4268fc", 
        token: "nfp_bqKqY4GBrd8MNNLxCiCssFhRN5qGfzWe82f7"
    });

    const headers = Object.fromEntries(
        Object.entries(event.headers).map(([k, v]) => [k.toLowerCase(), v])
    );

    if (!headers['content-type']) return { statusCode: 400, body: "No Content-Type" };

    let fileData = null;
    let fileName = "";
    const fields = {};

    return new Promise((resolve) => {
        const bb = busboy({ headers });
        bb.on('file', (name, file, info) => {
            fileName = info.filename;
            const chunks = [];
            file.on('data', (d) => chunks.push(d));
            file.on('end', () => { fileData = Buffer.concat(chunks); });
        });
        bb.on('field', (name, val) => { fields[name] = val; });
        bb.on('finish', async () => {
            if (!fileData) return resolve({ statusCode: 400, body: "No File" });
            try {
                const key = `${fields.resDate || '0000'}_${fields.userName || 'noname'}_${Date.now()}`;
                await store.set(key, fileData, { 
                    metadata: { 
                        userName: fields.userName,
                        userPhone: fields.userPhone,
                        resDate: fields.resDate,
                        resTime: fields.resTime,
                        originalFileName: fileName
                    } 
                });
                resolve({ statusCode: 200, body: "Success" });
            } catch (err) {
                resolve({ statusCode: 500, body: "Error: " + err.message });
            }
        });
        bb.end(Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8'));
    });
};
