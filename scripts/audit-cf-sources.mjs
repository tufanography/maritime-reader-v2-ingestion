// CF-bloklu kaynaklar için GHA'dan ölçüm (lokalde 403). SADECE RAPOR.
import { createClient } from '@supabase/supabase-js';
const sb=createClient(process.env.SUPABASE_URL||process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {auth:{persistSession:false}});
const UA={headers:{'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36'}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const BUILTIN=new Set(['post','page','attachment','nav_menu_item','wp_block','wp_template','wp_template_part','wp_global_styles','wp_navigation','wp_font_family','wp_font_face','wp_pattern','custom_css','customize_changeset','oembed_cache','user_request','revision','menu-item','wpcf7_contact_form']);
const targets=['Splash247','ABS','London P&I'];
for(const nm of targets){
  const { data: s } = await sb.from('sources').select('id,name,scraper_config').ilike('name','%'+nm+'%').limit(1);
  if(!s||!s.length){ console.log(nm+': DB yok'); continue; }
  const cfg=s[0].scraper_config, sid=s[0].id;
  const o=(()=>{try{return new URL(cfg.wp_rest_url||cfg.feed_url||cfg.url||(cfg.jobs&&cfg.jobs[0]&&cfg.jobs[0].list_url)).origin;}catch(e){return null;}})();
  console.log('\n=== '+s[0].name+'  ('+o+') ===');
  // WP-types
  let types=null; try{ const r=await fetch(o+'/wp-json/wp/v2/types',UA); if(r.status===200) types=await r.json().catch(()=>null); else console.log('  types HTTP '+r.status); }catch(e){ console.log('  types err '+e.message); }
  if(types){ const custom=Object.keys(types).filter(k=>!BUILTIN.has(k));
    for(const t of custom){ const rb=types[t].rest_base||t; try{ const r=await fetch(o+'/wp-json/wp/v2/'+rb+'?per_page=1',UA); const tot=+(r.headers.get('x-wp-total')||0); if(tot>=5) console.log('  custom: '+rb+' = '+tot); }catch(e){} await sleep(600); } }
  // ceyrek haritasi (delik var mi)
  await sleep(800);
  const q=[['pre-2024','1900-01-01','2024-01-01'],['2024','2024-01-01','2025-01-01'],['2025','2025-01-01','2026-01-01'],['2026-Oca-Nis','2026-01-01','2026-05-01'],['2026-May+','2026-05-01','2026-08-01']];
  console.log('  --- çeyrek haritası (bizde / kaynakta) ---');
  for(const [lbl,a,b] of q){
    const { count: ours } = await sb.from('articles').select('id',{count:'exact',head:true}).eq('source_id',sid).gte('published_at',a).lt('published_at',b);
    let wp='?'; try{ const r=await fetch(o+'/wp-json/wp/v2/posts?per_page=1&after='+a+'T00:00:00&before='+b+'T00:00:00',UA); wp=r.headers.get('x-wp-total')||'0'; }catch(e){}
    console.log('    '+lbl.padEnd(12)+' '+String(ours).padStart(5)+' / '+String(wp).padStart(6));
    await sleep(800);
  }
}
