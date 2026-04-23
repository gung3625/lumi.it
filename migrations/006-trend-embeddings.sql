-- 006-trend-embeddings.sql — Phase 4: pgvector 임베딩 + 관련 키워드 클러스터
-- 1. pgvector extension 활성화
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. embedding 컬럼 추가 (text-embedding-3-small = 1536차원)
ALTER TABLE public.trend_keywords
  ADD COLUMN IF NOT EXISTS embedding vector(1536) DEFAULT NULL;

-- 3. related_keywords 컬럼 추가 (코사인 유사도 ≥ 0.75, top-5)
ALTER TABLE public.trend_keywords
  ADD COLUMN IF NOT EXISTS related_keywords text[] DEFAULT NULL;

-- 4. HNSW 인덱스 (코사인 유사도 검색 가속)
CREATE INDEX IF NOT EXISTS idx_tk_embedding ON public.trend_keywords
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- 5. find_similar_keywords RPC — 카테고리 내 코사인 유사도 top-N 조회
CREATE OR REPLACE FUNCTION find_similar_keywords(
  row_id bigint,
  cat text,
  match_threshold float DEFAULT 0.75,
  match_count int DEFAULT 5
)
RETURNS TABLE (
  id bigint,
  keyword text,
  similarity float
)
LANGUAGE sql STABLE
AS $$
  WITH target AS (
    SELECT embedding FROM public.trend_keywords WHERE id = row_id
  )
  SELECT
    tk.id,
    tk.keyword,
    1 - (tk.embedding <=> (SELECT embedding FROM target)) AS similarity
  FROM public.trend_keywords tk
  WHERE tk.id != row_id
    AND tk.category = cat
    AND tk.embedding IS NOT NULL
    AND 1 - (tk.embedding <=> (SELECT embedding FROM target)) >= match_threshold
  ORDER BY tk.embedding <=> (SELECT embedding FROM target) ASC
  LIMIT match_count;
$$;
