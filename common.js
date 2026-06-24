/* ===== GMS shared runtime (plain JS, no build step) ===== */
"use strict";
(function(){
  const SUPABASE_URL = "https://dhddckamrkfleuigrsip.supabase.co";
  const PUBLISHABLE_KEY = "sb_publishable_p52IeJQKTTcg1M_cIL1ybA_j5G7rG0l";

  const GMS = {
    URL: SUPABASE_URL,
    KEY: PUBLISHABLE_KEY,
    sb: window.supabase.createClient(SUPABASE_URL, PUBLISHABLE_KEY),
    $: (id) => document.getElementById(id),
    isOnline: () => navigator.onLine,
  };

  // ---- utils ----
  GMS.uuid = function(){
    if(crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g,c=>{const r=Math.random()*16|0;return (c=="x"?r:(r&0x3|0x8)).toString(16);});
  };
  GMS.esc = function(s){ return String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); };
  GMS.fmtDate = function(iso){ if(!iso) return "-"; try{return new Date(iso).toLocaleString("id-ID",{day:"2-digit",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"});}catch(e){return iso;} };

  // ---- session + profile ----
  GMS.getSession = async function(){
    const { data } = await GMS.sb.auth.getSession();
    return data.session || null;
  };
  // returns {user, role, status, canValidate, isSuper, profile} or null if no session
  GMS.getProfile = async function(){
    const { data:{ user } } = await GMS.sb.auth.getUser();
    if(!user) return null;
    let role="member", status="pending", prof=null;
    try{
      const { data:rl } = await GMS.sb.from("user_roles").select("role,status,can_validate,full_name,badge_number,position,department,phone").eq("user_id",user.id).maybeSingle();
      if(rl){ prof=rl; role=rl.role||"member"; status=rl.status||"pending"; }
    }catch(e){ status="active"; } // fail-open to active member if RLS hiccup
    const isSuper = role==="super_admin";
    const canValidate = status==="active" && (role==="admin"||role==="super_admin");
    return { user, role, status, canValidate, isSuper, profile:prof, email:user.email };
  };

  GMS.logout = async function(){ try{ await GMS.sb.auth.signOut(); }catch(e){} location.href="index.html"; };

  // ---- page guard: ensure logged-in + active. else show standard screen. ----
  // opts: { requireAdmin:bool, mount:"#id" (container to blank when blocked) }
  // returns profile if allowed, otherwise null (and renders a block screen into <body>/mount)
  GMS.guard = async function(opts){
    opts = opts||{};
    const block = (html)=>{ const m = opts.mount?document.querySelector(opts.mount):document.body;
      if(m) m.innerHTML = '<div class="center">'+html+'</div>'; };
    const session = await GMS.getSession();
    if(!session){
      block('<div style="font-size:16px;font-weight:700;color:var(--txt)">Perlu login</div>'+
            '<div style="font-size:13px;max-width:320px">Sesi belum ada. Login dulu di halaman utama, lalu kembali ke sini.</div>'+
            '<a class="btn primary" style="text-decoration:none;max-width:220px" href="index.html">Ke Halaman Login</a>');
      return null;
    }
    const p = await GMS.getProfile();
    if(!p){ block('<div>Gagal memuat profil. Coba muat ulang.</div>'); return null; }
    if(p.status!=="active"){
      const dis = p.status==="disabled";
      block('<div style="width:56px;height:56px;border-radius:50%;background:#fef3c7;color:#d97706;display:flex;align-items:center;justify-content:center;font-size:26px">&#9888;</div>'+
            '<div style="font-size:17px;font-weight:700;color:var(--txt)">'+(dis?"Akun dinonaktifkan":"Menunggu persetujuan")+'</div>'+
            '<div style="font-size:13px;max-width:340px">'+(dis?"Akun ini dinonaktifkan oleh admin. Hubungi Super Admin.":"Akun kamu sudah terdaftar dan menunggu persetujuan Super Admin sebelum bisa dipakai.")+'</div>'+
            '<button class="btn" style="max-width:180px" onclick="GMS.logout()">Keluar</button>');
      return null;
    }
    if(opts.requireAdmin && !p.canValidate){
      block('<div style="font-size:16px;font-weight:700;color:var(--txt)">Akses ditolak</div>'+
            '<div style="font-size:13px;max-width:320px">Halaman ini hanya untuk admin/validator.</div>'+
            '<a class="btn primary" style="text-decoration:none;max-width:200px" href="index.html">Kembali</a>');
      return null;
    }
    return p;
  };

  // ---- standard header with optional back button ----
  GMS.header = function(title, sub, opts){
    opts = opts||{};
    const back = opts.back!==false ? '<a class="back" href="index.html">&#8592; Menu</a>' : '';
    const net  = opts.net ? '<span><span id="netDot" class="dot off"></span> <span id="netTxt">offline</span></span>' : '';
    return '<header class="gms"><div class="logo">&#9650;</div>'+
      '<div class="t">'+GMS.esc(title)+(sub?'<small>'+GMS.esc(sub)+'</small>':'')+'</div>'+
      '<div class="right">'+net+back+'</div></header>';
  };
  GMS.setNet = function(){ const on=GMS.isOnline(); const d=GMS.$("netDot"), t=GMS.$("netTxt");
    if(d) d.className="dot "+(on?"on":"off"); if(t) t.textContent=on?"online":"offline"; };

  window.GMS = GMS;
})();
