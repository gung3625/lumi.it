import { getStore } from "@netlify/blobs";
import busboy from "busboy";

export const handler = async (event) => {
 const store = getStore({ name: 'lumi_vault' });
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
 await store.setRaw(Date.now().toString(), fileData);
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
