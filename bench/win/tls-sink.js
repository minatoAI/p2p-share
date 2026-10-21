const tls=require('tls'), fs=require('fs');
const port=Number(process.argv[2]||9443); let total=0,t0=0;
const srv=tls.createServer({key:fs.readFileSync(__dirname+'/key.pem'),cert:fs.readFileSync(__dirname+'/cert.pem')}, s=>{
 s.on('data',d=>{if(!t0)t0=Date.now();total+=d.length});
 s.on('end',()=>{const dt=(Date.now()-t0)/1000;console.log(JSON.stringify({bytes:total,seconds:+dt.toFixed(2),mibps:+(total/1048576/dt).toFixed(1)}));srv.close()});
});
srv.listen(port,'0.0.0.0',()=>console.log('listening'));
setTimeout(()=>{console.log('timeout '+total);process.exit(2)},120000);
