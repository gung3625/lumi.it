import { getStore } from "@netlify/blobs";

export const handler = async (event) => {
    const store = getStore({ 
        name: 'lumi_vault',
        siteID: "28d60e0e-6aa4-4b45-b117-0bcc3c4268fc", 
        token: "nfp_bqKqY4GBrd8MNNLxCiCssFhRN5qGfzWe82f7"
    });

    try {
        const list = await store.list();
        const items = await Promise.all(list.blobs.map(async (blob) => {
            const entry = await store.getMetadata(blob.key);
            return { key: blob.key, metadata: entry.metadata };
        }));
        return {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(items)
        };
    } catch (err) {
        return { statusCode: 500, body: err.message };
    }
};
