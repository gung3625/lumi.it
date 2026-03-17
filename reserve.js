import { getStore } from "@netlify/blobs";
import busboy from "busboy";

export const handler = async (event) => {
    // 토큰(Key)은 필요 없지만, 가끔 Site ID를 직접 적어주면 길을 더 잘 찾습니다.
    const store = getStore({ 
        name: 'lumi_vault',
        // Netlify 대시보드 General > Site details에 있는 Site ID만 복사해서 넣어보세요.
        // siteID: "여기에_Site_ID_문자열만_넣기" 
    });
    
    // ... 나머지 코드 동일
