import { getStore } from "@netlify/blobs";

export const handler = async (event) => {
    const store = getStore({ 
        name: 'lumi_vault',
        siteID: "28d60e0e-6aa4-4b45-b117-0bcc3c4268fc", 
        token: "nfp_bqKqY4GBrd8MNNLxCiCssFhRN5qGfzWe82f7"
    });

    const fileKey = event.queryStringParameters.file;
    if (!fileKey) return { statusCode: 400, body: "Missing file key" };

    try {
        const file = await store.get(fileKey, { type: "blob" });
        return {
            statusCode: 200,
            headers: { "Content-Type": "image/jpeg" },
            body: Buffer.from(await file.arrayBuffer()).toString('base64'),
            isBase64Encoded: true
        };
    } catch (err) {
        return { statusCode: 404, body: "File Not Found" };
    }
};
