// Sprint 4 verify — in-memory Supabase mock client
// 실제 Supabase 인터페이스를 흉내내서 _shared/* 모듈이 그대로 동작하도록 함
//
// 지원: from(table).select().eq().gte().lte().lt().gt().is().in().like().neq().order().limit().maybeSingle()
//      from(table).insert().update().delete()
//      .single() / count head:true

const tables = new Map(); // tableName → array of rows

function reset() {
  tables.clear();
  // Sprint 1 sellers seed
  tables.set('sellers', [
    {
      id: 'seller-test-001',
      business_name: '루미테스트상점',
      industry: 'fashion',
    },
  ]);

  // products
  tables.set('products', [
    { id: 'prod-001', seller_id: 'seller-test-001', title: '봄 시폰 원피스', category: 'fashion' },
    { id: 'prod-002', seller_id: 'seller-test-001', title: '린넨 셔츠', category: 'fashion' },
  ]);

  // marketplace_orders (Sprint 3)
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  tables.set('marketplace_orders', [
    {
      id: 'ord-001', seller_id: 'seller-test-001', market: 'coupang',
      market_order_id: 'CP-001', total_price: 30000, quantity: 1, status: 'paid',
      tracking_number: null,
      created_at: new Date(now - 1 * day).toISOString(),
      stock_restored: false,
    },
    {
      id: 'ord-002', seller_id: 'seller-test-001', market: 'naver',
      market_order_id: 'NV-001', total_price: 50000, quantity: 2, status: 'shipping',
      tracking_number: '1234567890', courier_code: 'CJGLS',
      created_at: new Date(now - 2 * day).toISOString(),
      stock_restored: false,
    },
    {
      id: 'ord-003', seller_id: 'seller-test-001', market: 'coupang',
      market_order_id: 'CP-002', total_price: 25000, quantity: 1, status: 'delivered',
      tracking_number: '0987654321', courier_code: 'LOGEN',
      created_at: new Date(now - 5 * day).toISOString(),
      stock_restored: false,
    },
  ]);

  tables.set('cs_threads', [
    {
      id: 'cs-001', seller_id: 'seller-test-001', market: 'coupang',
      market_thread_id: 'CP-Q-001', status: 'pending', category: 'shipping',
      buyer_name_masked: '김**', preview_text: '배송 언제 와요?',
      created_at: new Date(now - 12 * 60 * 60 * 1000).toISOString(),
    },
  ]);

  // Sprint 4 tables
  tables.set('seller_cost_settings', []);
  tables.set('market_fee_table', [
    { id: 'fee-1', market: 'coupang', category_key: 'default', fee_ratio: 10.80, active: true },
    { id: 'fee-2', market: 'naver', category_key: 'default', fee_ratio: 5.50, active: true },
    { id: 'fee-3', market: 'toss', category_key: 'default', fee_ratio: 8.00, active: true },
  ]);
  tables.set('live_events', []);
  tables.set('market_sync_status', [
    {
      id: 'sync-1', seller_id: 'seller-test-001', market: 'coupang',
      health_status: 'healthy', consecutive_failures: 0,
      last_synced_at: new Date(now - 5 * 60000).toISOString(),
      last_success_at: new Date(now - 5 * 60000).toISOString(),
      orders_synced_24h: 3, cs_synced_24h: 1,
      updated_at: new Date().toISOString(),
    },
    {
      id: 'sync-2', seller_id: 'seller-test-001', market: 'naver',
      health_status: 'degraded', consecutive_failures: 1,
      last_synced_at: new Date(now - 30 * 60000).toISOString(),
      last_failure_at: new Date(now - 30 * 60000).toISOString(),
      last_error_message: '일시적 네트워크 오류',
      orders_synced_24h: 1, cs_synced_24h: 0,
      updated_at: new Date().toISOString(),
    },
  ]);
  tables.set('market_credentials', [
    { seller_id: 'seller-test-001', market: 'coupang' },
    { seller_id: 'seller-test-001', market: 'naver' },
  ]);
  tables.set('seller_trend_matches', []);
  tables.set('trend_dismissals', []);
  tables.set('season_events', [
    {
      id: 'se-1', event_name: '어버이날',
      event_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      alert_lead_days: 14,
      related_categories: ['flower', 'beauty'],
      related_keywords: ['카네이션', '효도선물'],
      message_template: '어버이날 D-{days}',
      active: true,
    },
  ]);
  tables.set('trend_keywords', [
    { keyword: '봄 시폰 원피스', category: 'fashion', velocity_pct: 342, signal_tier: 'rising', is_new: true, weighted_score: 95, axis: 'general', collected_date: new Date().toISOString().slice(0, 10) },
    { keyword: '린넨 셔츠', category: 'fashion', velocity_pct: 215, signal_tier: 'rising', is_new: false, weighted_score: 80, axis: 'general', collected_date: new Date().toISOString().slice(0, 10) },
    { keyword: '미디 스커트', category: 'fashion', velocity_pct: 168, signal_tier: 'rising', is_new: false, weighted_score: 70, axis: 'general', collected_date: new Date().toISOString().slice(0, 10) },
    { keyword: '말차 라떼', category: 'cafe', velocity_pct: 280, signal_tier: 'rising', is_new: true, weighted_score: 88, axis: 'menu', collected_date: new Date().toISOString().slice(0, 10) },
    { keyword: '캠핑 소품', category: 'shop', velocity_pct: 142, signal_tier: 'rising', is_new: false, weighted_score: 60, axis: 'goods', collected_date: new Date().toISOString().slice(0, 10) },
  ]);
  tables.set('trends', []);
  tables.set('profit_snapshots', []);
  tables.set('inventory_movements', []);
  tables.set('kill_switch_log', []);
  tables.set('cs_messages', []);
  tables.set('tracking_events', []);
  tables.set('courier_codes', [
    { code: 'CJGLS', display_name: 'CJ대한통운', smart_tracker_code: '04', active: true, display_order: 10 },
    { code: 'LOGEN', display_name: '로젠택배', smart_tracker_code: '06', active: true, display_order: 20 },
  ]);
}

reset();

function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }

class Query {
  constructor(tableName) {
    this.tableName = tableName;
    this.filters = [];
    this._order = null;
    this._limit = null;
    this._countMode = null;
    this._action = 'select';
    this._payload = null;
    this._selectFields = '*';
  }
  select(fields, opts) {
    // insert/update 후 .select()는 _action 유지 (returning behavior)
    if (this._action === 'select' || !this._action) {
      this._action = 'select';
    }
    this._selectFields = fields || '*';
    if (opts && opts.count === 'exact' && opts.head) this._countMode = 'head';
    else if (opts && opts.count === 'exact') this._countMode = 'exact';
    return this;
  }
  insert(payload) {
    this._action = 'insert';
    this._payload = payload;
    return this;
  }
  update(payload) {
    this._action = 'update';
    this._payload = payload;
    return this;
  }
  delete() {
    this._action = 'delete';
    return this;
  }
  upsert(payload) {
    this._action = 'upsert';
    this._payload = payload;
    return this;
  }
  eq(col, val) { this.filters.push(['eq', col, val]); return this; }
  neq(col, val) { this.filters.push(['neq', col, val]); return this; }
  gte(col, val) { this.filters.push(['gte', col, val]); return this; }
  lte(col, val) { this.filters.push(['lte', col, val]); return this; }
  gt(col, val) { this.filters.push(['gt', col, val]); return this; }
  lt(col, val) { this.filters.push(['lt', col, val]); return this; }
  is(col, val) { this.filters.push(['is', col, val]); return this; }
  in(col, vals) { this.filters.push(['in', col, vals]); return this; }
  like(col, pattern) { this.filters.push(['like', col, pattern]); return this; }
  order(col, opts) { this._order = { col, asc: opts ? !!opts.ascending : true }; return this; }
  limit(n) { this._limit = n; return this; }
  range(_a, _b) { return this; }
  maybeSingle() { this._single = 'maybe'; return this; }
  single() { this._single = 'one'; return this; }
  match(filter) { for (const k of Object.keys(filter || {})) this.filters.push(['eq', k, filter[k]]); return this; }
  then(onFulfilled, onRejected) {
    return Promise.resolve(this._execute()).then(onFulfilled, onRejected);
  }

  _matchRow(row) {
    for (const [op, col, val] of this.filters) {
      let rv = row[col];
      // boolean 컬럼은 undefined → false default (Supabase DEFAULT FALSE 시뮬레이션)
      if (rv === undefined && (val === true || val === false)) rv = false;
      switch (op) {
        case 'eq': if (rv !== val) return false; break;
        case 'neq': if (rv === val) return false; break;
        case 'gte': if (!(rv >= val)) return false; break;
        case 'lte': if (!(rv <= val)) return false; break;
        case 'gt': if (!(rv > val)) return false; break;
        case 'lt': if (!(rv < val)) return false; break;
        case 'is': if (val === null) { if (rv !== null && rv !== undefined) return false; } else if (rv !== val) return false; break;
        case 'in': if (!Array.isArray(val) || !val.includes(rv)) return false; break;
        case 'like': {
          const pattern = String(val).replace(/%/g, '.*');
          const re = new RegExp('^' + pattern + '$');
          if (!re.test(String(rv || ''))) return false;
          break;
        }
      }
    }
    return true;
  }

  _execute() {
    if (!tables.has(this.tableName)) tables.set(this.tableName, []);
    const arr = tables.get(this.tableName);

    if (this._action === 'insert' || this._action === 'upsert') {
      const payloads = Array.isArray(this._payload) ? this._payload : [this._payload];
      const inserted = [];
      for (const p of payloads) {
        const row = { ...p, id: p.id || `${this.tableName}-${Math.random().toString(36).slice(2, 9)}` };
        if (!row.created_at) row.created_at = new Date().toISOString();
        if (!row.updated_at) row.updated_at = new Date().toISOString();
        arr.push(row);
        inserted.push(clone(row));
      }
      // single → 첫번째, maybe → 첫번째 또는 null, 그외 → 배열
      if (this._single === 'one' || this._single === 'maybe') {
        return { data: inserted[0] || null, error: null };
      }
      if (Array.isArray(this._payload)) {
        return { data: inserted, error: null };
      }
      // 단일 insert지만 .single() 없으면 — supabase는 보통 배열 반환
      return { data: inserted, error: null };
    }

    if (this._action === 'update') {
      const matched = arr.filter(r => this._matchRow(r));
      for (const r of matched) Object.assign(r, this._payload, { updated_at: new Date().toISOString() });
      return { data: matched.map(clone), error: null };
    }

    if (this._action === 'delete') {
      const before = arr.length;
      const remaining = arr.filter(r => !this._matchRow(r));
      tables.set(this.tableName, remaining);
      return { data: null, error: null, count: before - remaining.length };
    }

    // select
    let rows = arr.filter(r => this._matchRow(r));
    if (this._order) {
      rows.sort((a, b) => {
        const av = a[this._order.col];
        const bv = b[this._order.col];
        if (av < bv) return this._order.asc ? -1 : 1;
        if (av > bv) return this._order.asc ? 1 : -1;
        return 0;
      });
    }
    if (this._limit) rows = rows.slice(0, this._limit);

    if (this._countMode === 'head') {
      return { count: rows.length, error: null, data: null };
    }

    if (this._single === 'maybe') {
      return { data: rows[0] ? clone(rows[0]) : null, error: null };
    }
    if (this._single === 'one') {
      if (rows.length === 0) return { data: null, error: { message: 'no rows' } };
      return { data: clone(rows[0]), error: null };
    }
    return { data: rows.map(clone), error: null, count: rows.length };
  }
}

function from(tableName) { return new Query(tableName); }

function getAdminClient() {
  return { from, channel: () => ({ on: () => ({ subscribe: () => {} }) }) };
}

module.exports = {
  getAdminClient,
  reset,
  _tables: tables, // 디버깅용
};
