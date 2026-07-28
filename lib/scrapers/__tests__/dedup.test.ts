// Tests the SHIPPED fetchKnownHashes, not a copy of its loop.
// Run: npx tsx lib/scrapers/__tests__/dedup.test.ts
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { fetchKnownHashes } from '../orchestrator';

let pass = 0;
const failures: string[] = [];
const check = (name: string, actual: unknown, expected: unknown) => {
  if (actual === expected) { pass++; return; }
  failures.push(`  ${name}\n     beklenen: ${JSON.stringify(expected)}\n     gelen   : ${JSON.stringify(actual)}`);
};

// --- 1. Chunking: a fake client records how it was called ------------------
// Proves the shipped function splits the list; the old code sent one unbounded
// .in() call, which 400s past ~400 hashes (measured against the live API).
const seenChunks: number[] = [];
const fakeOk = {
  from: () => ({
    select: () => ({
      in: async (_col: string, values: string[]) => {
        seenChunks.push(values.length);
        // echo back every other hash as "already known"
        return { data: values.filter((_, i) => i % 2 === 0).map((v) => ({ url_hash: v })), error: null };
      },
    }),
  }),
};
const many = Array.from({ length: 450 }, (_, i) => `hash${String(i).padStart(28, '0')}`);
const r1 = await fetchKnownHashes(fakeOk as any, many);
check('450 hash -> 3 parca', seenChunks.length, 3);
check('parca boyutlari 200/200/50', seenChunks.join(','), '200,200,50');
check('bilinen sayisi (her ikincisi)', r1.known.size, 225);
check('hata yok', r1.error, undefined);

// --- 2. Failure must NOT look like "nothing is known" ----------------------
// The whole point of the fix: a failed lookup used to return an empty set,
// which reads as "no history" and re-inserts the entire feed.
const fakeFail = {
  from: () => ({
    select: () => ({
      in: async () => ({ data: null, error: { message: 'Bad Request' } }),
    }),
  }),
};
const r2 = await fetchKnownHashes(fakeFail as any, many);
check('hata bildiriliyor', r2.error, 'Bad Request');
check('hata durumunda kume BOS (kismi degil)', r2.known.size, 0);

// --- 3. Failure midway must not return a partial set -----------------------
// A partial set is worse than none: the rows it omits get re-inserted.
let calls = 0;
const fakeHalf = {
  from: () => ({
    select: () => ({
      in: async (_c: string, values: string[]) => {
        calls++;
        if (calls === 1) return { data: values.map((v) => ({ url_hash: v })), error: null };
        return { data: null, error: { message: 'timeout' } };
      },
    }),
  }),
};
const r3 = await fetchKnownHashes(fakeHalf as any, many);
check('ikinci parca patlarsa hata donuyor', r3.error, 'timeout');
check('ilk parcanin 200 sonucu ATILIYOR', r3.known.size, 0);

// --- 4. Empty input ---------------------------------------------------------
const r4 = await fetchKnownHashes(fakeOk as any, []);
check('bos girdi -> bos kume, hata yok', `${r4.known.size}/${r4.error}`, '0/undefined');

// --- 5. Against the LIVE database ------------------------------------------
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: real } = await sb.from('articles').select('url_hash').limit(250);
  const realHashes = (real ?? []).map((r: any) => r.url_hash);
  const fabricated = ['ffffffffffffffffffffffffffffff01', 'ffffffffffffffffffffffffffffff02', 'ffffffffffffffffffffffffffffff03'];
  const live = await fetchKnownHashes(sb as any, [...realHashes, ...fabricated]);
  check('canli: gercek hashler bulundu', live.known.size, realHashes.length);
  check('canli: uydurma hashler bulunmadi', fabricated.some((f) => live.known.has(f)), false);
  check('canli: hata yok', live.error, undefined);
} else {
  console.log('(canli DB testi atlandi — .env yok)');
}

console.log(`${pass} test gecti, ${failures.length} basarisiz`);
if (failures.length) { console.log('\nBASARISIZ:\n' + failures.join('\n\n')); process.exit(1); }
