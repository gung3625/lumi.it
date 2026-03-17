import { getStore } from "@netlify/blobs";

export const handler = async () => {
 const store = getStore({ name: 'lumi_vault' });
 const blobs = await store.list();
 const results = await Promise.all(blobs.map(async blob => {
 const item = await store.getMetadata(blob.key);
 return { key: blob.key, ...item.metadata };
 }));
 return { statusCode: 200, body: JSON.stringify(results) };
};