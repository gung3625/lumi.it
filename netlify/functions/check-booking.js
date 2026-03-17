import { getStore } from "@netlify/blobs";

export const handler = async (event) => {
    const date = event.queryStringParameters.date;
    const store = getStore({ 
        name: 'lumi_vault',
        siteID: "28d60e0e-6aa4-4b45-b117-0bcc3c4268fc", 
        token: "nfp_bqKqY4GBrd8MNNLxCiCssFhRN5qGfzWe82f7"
    });

    try {
        const list = await store.list();
        const bookedTimes = [];

        for (const blob of list.blobs) {
            const meta = await store.getMetadata(blob.key);
            if (meta && meta.metadata.resDate === date) {
                bookedTimes.push(meta.metadata.resTime);
            }
        }

        return {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(bookedTimes)
        };
    } catch (e) {
        return { statusCode: 500, body: JSON.stringify([]) };
    }
};
