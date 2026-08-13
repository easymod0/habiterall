
import { fileURLToPath as _f2u } from 'node:url';
import { dirname as _dn, join as _jn } from 'node:path';
import { pathToFileURL as _p2u } from 'node:url';
/** Resolve a module in shared/public relative to this file, not the cwd. */
const sharedPublic = (name) =>
  _p2u(_jn(_dn(_f2u(import.meta.url)), '..', '..', 'public', name)).href;
// Verify at_most habits paint 0 as a full success.
class N{constructor(n){this.name=n;this.attrs={};this.children=[];this.text=null;}
 setAttribute(k,v){this.attrs[k]=String(v);}getAttribute(k){return this.attrs[k];}
 appendChild(c){this.children.push(c);return c;}addEventListener(){}
 set textContent(v){this.text=v;}get textContent(){return this.text;}
 walk(f){f(this);for(const c of this.children)c.walk(f);}}
globalThis.document={documentElement:{dataset:{theme:'light'}},
 createElementNS:(ns,n)=>new N(n),createElement:(n)=>new N(n)};
globalThis.getComputedStyle=()=>({getPropertyValue:(n)=>({
 '--text-dim':'#666e7d','--border':'#dcdfe6','--grid-empty':'#e6e9ef',
 '--text':'#14181f','--surface-2':'#eef0f4'}[n]??'#000')});

const {calendarChart}=await import(sharedPublic('charts.js'));
let fails=0;
const check=(l,c,e='')=>{console.log(`${c?'PASS':'FAIL'}  ${l}${e?' :: '+e:''}`);if(!c)fails++;};

const today=new Date();today.setHours(0,0,0,0);
const iso=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const ago=n=>iso(new Date(today.getTime()-n*86400000));
const d0=ago(7), d1=ago(8), d2=ago(9);   // safely inside a 4-week grid

const paint=(entries,color,habit)=>{
  const svg=calendarChart(entries,color,habit,{weeks:4,skips:new Set()});
  const out={};
  svg.walk(n=>{ if(n.name!=='rect')return;
    const t=n.children.find(c=>c.name==='title');
    if(t&&t.text) out[String(t.text).split(':')[0]]=n.attrs.fill; });
  return out;
};

const snacks={type:'numerical',target_value:0,target_type:'at_most',unit:'snacks'};
const cells=paint({[d0]:0,[d1]:2,[d2]:1},'#10b981',snacks);
const empty='#e6e9ef';

check('0 snacks (perfect) is painted, not blank', cells[d0]&&cells[d0]!==empty, `fill=${cells[d0]}`);
check('0 snacks gets FULL strength colour', cells[d0]==='rgb(16, 185, 129)', cells[d0]);
check('2 snacks dimmer than 0', cells[d1]!==cells[d0], `fill=${cells[d1]}`);
check('1 vs 2 snacks are distinguishable', cells[d2]!==cells[d1], `1=${cells[d2]} 2=${cells[d1]}`);
check('1 snack still painted', cells[d2]&&cells[d2]!==empty, `fill=${cells[d2]}`);

const water={type:'numerical',target_value:8,target_type:'at_least',unit:'glasses'};
const c2=paint({[d0]:0,[d1]:8,[d2]:4},'#0ea5e9',water);
check('at_least: 0 glasses stays blank', c2[d0]===empty, `fill=${c2[d0]}`);
check('at_least: 8 glasses full colour', c2[d1]==='rgb(14, 165, 233)', c2[d1]);
check('at_least: 4 glasses partial', c2[d2]!==empty&&c2[d2]!==c2[d1], `fill=${c2[d2]}`);

const bool={type:'boolean',target_value:0,target_type:'at_least'};
const c3=paint({[d0]:2,[d1]:0},'#8b5cf6',bool);
check('boolean: done is full colour', c3[d0]==='rgb(139, 92, 246)', c3[d0]);
check('boolean: not-done stays blank', c3[d1]===empty, c3[d1]);

console.log(fails===0?'\nALL AT-MOST CHECKS PASSED':`\n${fails} FAILED`);
process.exit(fails===0?0:1);
