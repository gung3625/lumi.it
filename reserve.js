import { getStore } from "@netlify/blobs";
import busboy from "busboy";

export const handler = async (event) => {
 const store = getStore({ name: 'lumi_vault', projectId: '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc', accessToken: 'nfp_bqKqY4GBrd8MNNLxCiCssFhRN5qGfzWe82f7' });
 let fileData = null;

 return new Promise((resolve) => {
 const bb = busboy({ headers: event.headers });
 bb.on('file', (name, file) => {
 const chunks = [];
 file.on('data', (d) => chunks.push(d));
 file.on('end', () => { fileData = Buffer.concat(chunks); });
 });
 bb.on('finish', async () => {
 if (fileData) {
 try {
 await store.set(Date.now().toString(), fileData, {
 metadata: { 
 sender: 'test_sender', // 여기에는 실제 사용자 정보를 넣어야 함
 reservedAt: new Date().toISOString()
 }
 });
 resolve({ statusCode: 200, body: "Success" });
 } catch (err) {
 resolve({ statusCode: 500, body: "Vault Error" });
 }
 } else {
 resolve({ statusCode: 400, body: "No File" });
 }
 });
 bb.end(Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8'));
 });
};