const tls=require('tls');
const host=process.argv[2], port=Number(process.argv[3]||9444), total=100*1024*1024;
const buf=Buffer.alloc(1024*1024,0x62); let sent=0,t0=0;
const s=tls.connect({host,port,rejectUnauthorized:false},()=>{t0=Date.now();pump()});
function pump(){while(sent<total){const n=Math.min(buf.length,total-sent);sent+=n;if(!s.write(n===buf.length?buf:buf.subarray(0,n))){s.once('drain',pump);return}}s.end()}
s.on('finish',()=>{const dt=(Date.now()-t0)/1000;console.log(JSON.stringify({bytes:sent,seconds:+dt.toFixed(2),mibps:+(sent/1048576/dt).toFixed(1)}))});
s.on('error',e=>{console.error(e.message);process.exit(1)});
setTimeout(()=>{console.log('timeout '+sent);process.exit(2)},120000);
