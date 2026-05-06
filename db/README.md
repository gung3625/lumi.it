# db/ — 임시 ad-hoc SQL 스크립트 (보존용)

이 폴더의 파일들은 초기 개발 중 Supabase SQL Editor에서 수동으로 실행된
일회성 스크립트입니다. **정식 마이그레이션으로 이전 완료** — 새 환경에는
아래 migration 파일을 사용하세요.

| 파일 | 이전된 마이그레이션 |
|------|-------------------|
| `add_brand_library.sql` | `supabase/migrations/20260501000008_brand_library_tables.sql` |
| `add_is_brand_auto.sql` | `supabase/migrations/20260501000009_reservations_brand_auto_columns.sql` |
| `add_is_admin.sql`      | `supabase/migrations/20260501000010_users_is_admin_column.sql` |

원본 파일은 히스토리 참고용으로 보존합니다. 새 스키마 변경은
`supabase/migrations/` 에 번호 파일로 추가하세요.
