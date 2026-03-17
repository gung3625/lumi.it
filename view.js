import { getStore } from "@netlify/blobs";

export const handler = async (event) => {
 // 1. 금고 연결 (사장님 전용 열쇠)
 const store = getStore({ 
 name: 'lumi_vault',
 siteID: "28d60e0e-6aa4-4b45-b117-0bcc3c4268fc", 
 token: "nfp_bqKqY4GBrd8MNNLxCiCssFhRN5qGfzWe82f7"
 });

 // 2. 주소창에서 어떤 사진을 가져올지 확인 (예: ?file=파일명)
 const fileKey = event.queryStringParameters.file;
 if (!fileKey) {
 return { statusCode: 400, body: "파일명이 누락되었습니다." };
 }

 try {
 // 3. 금고에서 사진 데이터를 가져옴
 const file = await store.get(fileKey, { type: "blob" });
 
 // 4. 사진 데이터를 웹브라우저가 이해할 수 있는 형태(Base64)로 변환해서 전송
 const arrayBuffer = await file.arrayBuffer();
 return {
 statusCode: 200,
 headers: { 
 "Content-Type": "image/jpeg", // 사진으로 인식하게 함
 "Cache-Control": "public, max-age=3600" 
 },
 body: Buffer.from(arrayBuffer).toString('base64'),
 isBase64Encoded: true
 };
 } catch (err) {
 return { statusCode: 404, body: "금고에서 사진을 찾을 수 없습니다: " + err.message };
 }
};