// Loans — unified debt tracking (institutional + private/family)
// Single source of truth for all debt. Property form is read-only for loan data.

var _loansData = null;
var _loansView = 'all';
var INST_TYPES = ['bank', 'credit_union', 'conventional'];
function _isInst(t) { return INST_TYPES.indexOf(t) >= 0; }

async function loadPrivateLoansTab() {
  var el = document.getElementById('privateLoansContent');
  if (!el) return;
  el.innerHTML = '<div style="padding:20px;text-align:center;"><div class="spinner"></div></div>';
  try {
    var d = await api('/api/loans');
    _loansData = d;
    _renderLoansPage(d, el);
  } catch (err) {
    el.innerHTML = '<p style="color:var(--danger);padding:12px;">Error loading loans: ' + esc(err.message) + '</p>';
  }
}

function _renderLoansPage(d, el) {
  var loans = d.loans || [];
  var active = loans.filter(function(l) { return l.status === 'active'; });
  var inst = loans.filter(function(l) { return _isInst(l.lender_type); });
  var pvt = loans.filter(function(l) { return !_isInst(l.lender_type); });
  var aI = inst.filter(function(l) { return l.status === 'active'; });
  var aP = pvt.filter(function(l) { return l.status === 'active'; });
  var totalBal = active.reduce(function(s,l){return s+(l.computed_balance||0);},0);
  var totalMo = active.reduce(function(s,l){return s+(l.monthly_payment||0);},0);
  var wN=0,wD=0; active.forEach(function(l){var b=l.computed_balance||0;wN+=(l.interest_rate||0)*b;wD+=b;});
  var wavg = wD>0?(wN/wD):0;

  var h = '<div class="card"><div class="card-header"><h2>'+_ico('handCoins',20)+' Loans & Debt</h2>';
  h += '<div style="display:flex;gap:6px;"><button class="btn btn-xs" onclick="loadPrivateLoansTab()">Refresh</button>';
  h += '<button class="btn btn-xs btn-purple" onclick="showLoanForm()">+ Add Loan</button></div></div>';

  h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:16px;">';
  h += _lc('Total Debt','$'+_fK(totalBal),'receipt','#ef4444');
  h += _lc('Institutional','$'+_fK(aI.reduce(function(s,l){return s+(l.computed_balance||0);},0)),'building','var(--accent)',aI.length+' loan'+(aI.length!==1?'s':''));
  h += _lc('Private/Family','$'+_fK(aP.reduce(function(s,l){return s+(l.computed_balance||0);},0)),'handCoins','#8b5cf6',aP.length+' loan'+(aP.length!==1?'s':''));
  h += _lc('Monthly Total','$'+_fK(totalMo),'calendar','#f59e0b');
  h += _lc('Wtd Avg Rate',wavg.toFixed(2)+'%','trendUp','#3b82f6');
  h += '</div>';

  // Maturity warnings
  var now=new Date(),sixMo=new Date(now);sixMo.setMonth(sixMo.getMonth()+6);
  var maturing=active.filter(function(l){return l.maturity_date&&new Date(l.maturity_date)<=sixMo;});
  if(maturing.length>0){
    h+='<div style="background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.3);border-radius:8px;padding:10px 14px;margin-bottom:14px;font-size:0.82rem;">';
    h+=_ico('alertCircle',14,'#f59e0b')+' <strong style="color:#f59e0b;">'+maturing.length+' loan'+(maturing.length>1?'s':'')+' maturing within 6 months:</strong> ';
    h+=maturing.map(function(l){return'<span style="color:var(--text);">'+esc(l.lender_name)+' ($'+_fK(l.computed_balance)+' due '+l.maturity_date+')</span>';}).join(', ');
    h+='</div>';
  }

  // Filter tabs
  h+='<div style="display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap;">';
  ['all','institutional','private'].forEach(function(v){
    var cnt=v==='institutional'?inst.length:v==='private'?pvt.length:loans.length;
    var lbl=v==='all'?'All':v==='institutional'?_ico('building',12)+' Institutional':_ico('handCoins',12)+' Private & Family';
    h+='<button class="btn btn-xs'+(_loansView===v?' btn-purple':'')+'" onclick="_loansView=\''+v+'\';_renderLoansPage(_loansData,document.getElementById(\'privateLoansContent\'))">'+lbl+' ('+cnt+')</button>';
  });
  h+='</div>';

  var filtered=_loansView==='institutional'?inst:_loansView==='private'?pvt:loans;
  if(filtered.length===0){
    h+='<div style="text-align:center;padding:30px;color:var(--text3);">';
    h+=loans.length===0?_ico('handCoins',32,'var(--text3)')+'<p style="margin-top:8px;">No loans tracked yet.</p><p style="font-size:0.78rem;">Existing property mortgages auto-migrate on first load.</p><button class="btn btn-purple" onclick="showLoanForm()" style="margin-top:10px;">+ Add First Loan</button>':'<p>No '+_loansView+' loans.</p>';
    h+='</div>';
  } else {
    h+='<div style="overflow-x:auto;"><table class="comp-table" style="font-size:0.78rem;width:100%;"><thead><tr><th>Lender</th><th>Type</th><th>Original</th><th>Balance</th><th>Rate</th><th>Payment</th><th>Term</th><th>Property</th><th>Status</th><th>Maturity</th><th></th></tr></thead><tbody>';
    filtered.forEach(function(l){
      var sc=l.status==='active'?'#10b981':l.status==='paid_off'?'var(--text3)':l.status==='defaulted'?'var(--danger)':'#f59e0b';
      var mw=l.status==='active'&&l.maturity_date&&new Date(l.maturity_date)<=sixMo?' style="color:#f59e0b;font-weight:600;"':'';
      var pl=l.property_name?(l.unit_number?l.unit_number+' · ':'')+l.property_name:'— business —';
      if(pl.length>25)pl=pl.substring(0,25)+'…';
      h+='<tr style="cursor:pointer;" onclick="showLoanModal('+l.id+')">';
      h+='<td style="font-weight:600;color:var(--accent);">'+esc(l.lender_name)+'</td>';
      h+='<td>'+_lBadge(l.lender_type)+'</td>';
      h+='<td style="font-family:DM Mono,monospace;">$'+(l.loan_amount||0).toLocaleString()+'</td>';
      h+='<td style="font-family:DM Mono,monospace;font-weight:600;">$'+(l.computed_balance||0).toLocaleString()+'</td>';
      h+='<td>'+(l.interest_rate||0)+'%</td>';
      h+='<td style="font-family:DM Mono,monospace;">$'+(l.monthly_payment||0).toLocaleString()+'</td>';
      h+='<td>'+(l.term_months?_tLbl(l.term_months):'—')+'</td>';
      h+='<td style="font-size:0.72rem;">'+esc(pl)+'</td>';
      h+='<td><span style="color:'+sc+';font-size:0.72rem;font-weight:600;text-transform:uppercase;">'+esc(l.status)+'</span></td>';
      h+='<td'+mw+'>'+(l.maturity_date||'—')+'</td>';
      h+='<td><button class="btn btn-xs" onclick="event.stopPropagation();showLoanForm('+l.id+')">Edit</button> <button class="btn btn-xs" style="color:var(--danger);" onclick="event.stopPropagation();_delLoan('+l.id+',\''+esc(l.lender_name).replace(/'/g,"\\'")+'\')">×</button></td>';
      h+='</tr>';
    });
    h+='</tbody></table></div>';
  }
  h+='</div>';
  el.innerHTML=h;
}

// ═══ HELPERS ═══
function _lc(l,v,i,c,s){return'<div style="background:var(--surface2);border-radius:8px;padding:12px;border:1px solid var(--border);"><div style="font-size:0.68rem;color:var(--text3);text-transform:uppercase;display:flex;align-items:center;gap:4px;">'+_ico(i,12,c)+' '+l+'</div><div style="font-size:1.1rem;font-weight:700;color:'+c+';font-family:DM Mono,monospace;margin-top:2px;">'+v+'</div>'+(s?'<div style="font-size:0.65rem;color:var(--text3);margin-top:1px;">'+s+'</div>':'')+'</div>';}
function _lBadge(t){var c={family:'#8b5cf6','private':'#3b82f6',seller:'#f59e0b',partner:'#10b981',bank:'#6366f1',credit_union:'#6366f1',conventional:'#6366f1'};var n={bank:'Bank',credit_union:'Credit Union',conventional:'Conventional',family:'Family','private':'Private',seller:'Seller',partner:'Partner'};var cc=c[t]||'var(--text3)';return'<span style="font-size:0.68rem;padding:2px 6px;border-radius:4px;background:'+cc+'22;color:'+cc+';font-weight:600;">'+esc(n[t]||t||'Other')+'</span>';}
function _fK(n){if(n==null)return'0';if(n>=1e6)return(n/1e6).toFixed(1)+'M';if(n>=1e4)return(n/1e3).toFixed(0)+'K';if(n>=1e3)return(n/1e3).toFixed(1)+'K';return Math.round(n).toLocaleString();}
function _tLbl(m){if(m>=12&&m%12===0)return(m/12)+'yr';if(m>=12)return Math.floor(m/12)+'yr '+(m%12)+'mo';return m+'mo';}
function _calcPmt(principal,rateAnn,termMo){if(!principal||!rateAnn||!termMo)return 0;var r=rateAnn/100/12;return principal*(r*Math.pow(1+r,termMo))/(Math.pow(1+r,termMo)-1);}

// ═══ ADD / EDIT FORM ═══
async function showLoanForm(editId) {
  var loan = null;
  if (editId) { try { var d=await api('/api/loans/'+editId); loan=d.loan; } catch(e){alert('Error: '+e.message);return;} }
  var isEdit=!!loan;
  var h='<div id="loanFormModal" style="position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;padding:16px;" onclick="if(event.target===this)this.remove()">';
  h+='<div style="background:var(--surface);border-radius:12px;width:100%;max-width:580px;max-height:90vh;overflow-y:auto;border:1px solid var(--border);padding:20px;">';
  h+='<h3 style="margin-bottom:14px;">'+_ico('handCoins',18)+' '+(isEdit?'Edit Loan':'Add Loan')+'</h3>';

  if(!isEdit){
    h+='<div style="display:flex;gap:8px;margin-bottom:14px;">';
    h+='<button class="btn btn-xs" id="lcI" onclick="_sLC(\'i\')" style="flex:1;">🏦 Institutional</button>';
    h+='<button class="btn btn-xs btn-purple" id="lcP" onclick="_sLC(\'p\')" style="flex:1;">🤝 Private / Family</button>';
    h+='</div>';
  }

  var F=function(l,id,v,t){return'<div><label style="font-size:0.72rem;color:var(--text3);display:block;margin-bottom:3px;">'+l+'</label><input id="'+id+'" type="'+t+'" value="'+esc(String(v==null?'':v))+'" style="width:100%;padding:8px;border-radius:6px;border:1px solid var(--border);background:var(--surface2);color:var(--text);font-size:0.82rem;box-sizing:border-box;"'+(t==='number'?' step="any"':'')+'></div>';};
  var S=function(l,id,opts,sel,fw){
    var labels={conventional:'Conventional',bank:'Bank',credit_union:'Credit Union','private':'Private',family:'Family',seller:'Seller Financing',partner:'Partner',fixed:'Fixed',interest_only:'Interest Only',balloon:'Balloon',deferred:'Deferred',custom:'Custom',property_acquisition:'Property Acquisition',down_payment:'Down Payment',renovation:'Renovation',operating_capital:'Operating Capital',refinance:'Refinance',heloc:'HELOC',other:'Other',active:'Active',paid_off:'Paid Off',defaulted:'Defaulted',restructured:'Restructured'};
    var r='<div'+(fw?' style="margin-top:10px;"':'')+'><label style="font-size:0.72rem;color:var(--text3);display:block;margin-bottom:3px;">'+l+'</label><select id="'+id+'" style="width:100%;padding:8px;border-radius:6px;border:1px solid var(--border);background:var(--surface2);color:var(--text);font-size:0.82rem;">';
    opts.forEach(function(o){r+='<option value="'+o+'"'+(o===sel?' selected':'')+'>'+(o===''?'— Select —':(labels[o]||o))+'</option>';});
    return r+'</select></div>';
  };

  h+='<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">';
  h+=F('Lender Name *','lnN',loan?loan.lender_name:'','text');
  h+=S('Type','lnT',['conventional','bank','credit_union','private','family','seller','partner'],loan?loan.lender_type:'private');
  h+=F('Loan Amount *','lnA',loan?loan.loan_amount:'','number');
  h+=F('Current Balance','lnB',loan&&loan.current_balance!=null?loan.current_balance:'','number');
  h+=F('Interest Rate (%)','lnR',loan?loan.interest_rate:'','number');
  h+=F('Term (months)','lnM',loan?loan.term_months:'','number');
  h+=F('Monthly Payment','lnP',loan?loan.monthly_payment:'','number');
  h+=S('Payment Type','lnPT',['fixed','interest_only','balloon','deferred','custom'],loan?loan.payment_type:'fixed');
  h+=F('Start Date','lnSD',loan?loan.start_date:'','date');
  h+=F('Maturity Date','lnMD',loan?loan.maturity_date:'','date');
  h+=F('Balloon Amount','lnBA',loan?loan.balloon_amount:'','number');
  h+=F('Balloon Date','lnBD',loan?loan.balloon_date:'','date');
  h+='</div>';

  // Mortgage calculator
  h+='<div style="margin-top:10px;padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;">';
  h+='<div style="font-size:0.72rem;color:var(--text3);font-weight:600;margin-bottom:6px;">'+_ico('dollarSign',12)+' Quick Calculator</div>';
  h+='<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:end;">';
  h+='<div style="flex:1;min-width:80px;"><label style="font-size:0.65rem;color:var(--text3);">Price</label><input id="lnCalcPrice" type="number" style="width:100%;padding:5px 7px;border-radius:5px;border:1px solid var(--border);background:var(--surface2);color:var(--text);font-size:0.78rem;box-sizing:border-box;" oninput="_lnCalc()"></div>';
  h+='<div style="width:60px;"><label style="font-size:0.65rem;color:var(--text3);">Down %</label><input id="lnCalcDown" type="number" value="20" style="width:100%;padding:5px 7px;border-radius:5px;border:1px solid var(--border);background:var(--surface2);color:var(--text);font-size:0.78rem;box-sizing:border-box;" oninput="_lnCalc()"></div>';
  h+='<div style="width:55px;"><label style="font-size:0.65rem;color:var(--text3);">Rate %</label><input id="lnCalcRate" type="number" value="7" step="0.125" style="width:100%;padding:5px 7px;border-radius:5px;border:1px solid var(--border);background:var(--surface2);color:var(--text);font-size:0.78rem;box-sizing:border-box;" oninput="_lnCalc()"></div>';
  h+='<div style="width:55px;"><label style="font-size:0.65rem;color:var(--text3);">Years</label><select id="lnCalcTerm" style="width:100%;padding:5px;border-radius:5px;border:1px solid var(--border);background:var(--surface2);color:var(--text);font-size:0.78rem;" onchange="_lnCalc()"><option value="30">30</option><option value="20">20</option><option value="15">15</option><option value="10">10</option></select></div>';
  h+='<button class="btn btn-xs" onclick="_lnCalcApply()" type="button" style="margin-bottom:1px;">Apply ↓</button>';
  h+='</div>';
  h+='<div id="lnCalcResult" style="font-size:0.72rem;color:var(--text3);margin-top:4px;"></div>';
  h+='</div>';

  h+='<div style="margin-top:10px;"><label style="font-size:0.72rem;color:var(--text3);display:block;margin-bottom:3px;">Linked Property</label>';
  h+='<select id="lnPr" style="width:100%;padding:8px;border-radius:6px;border:1px solid var(--border);background:var(--surface2);color:var(--text);font-size:0.82rem;"><option value="">— None (business-level) —</option></select></div>';
  h+=S('Purpose','lnPu',['','property_acquisition','down_payment','renovation','operating_capital','refinance','heloc','other'],loan?loan.purpose:'',true);
  h+=S('Status','lnSt',['active','paid_off','defaulted','restructured'],loan?loan.status:'active',true);
  h+='<div style="margin-top:10px;">'+F('Collateral','lnCo',loan?loan.collateral:'','text')+'</div>';
  h+='<div style="margin-top:10px;"><label style="font-size:0.72rem;color:var(--text3);display:block;margin-bottom:3px;">Notes</label>';
  h+='<textarea id="lnNo" rows="2" style="width:100%;padding:8px;border-radius:6px;border:1px solid var(--border);background:var(--surface2);color:var(--text);font-size:0.82rem;resize:vertical;box-sizing:border-box;">'+esc(loan?loan.notes||'':'')+'</textarea></div>';

  h+='<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">';
  h+='<button class="btn" onclick="document.getElementById(\'loanFormModal\').remove()">Cancel</button>';
  h+='<button class="btn btn-purple" onclick="_saveLoan('+(isEdit?loan.id:'')+')">'+(isEdit?'Save':'Create Loan')+'</button>';
  h+='</div></div></div>';
  document.body.insertAdjacentHTML('beforeend',h);
  _lnPopProps(loan?loan.property_id:null);
  if(!isEdit)_sLC('p');
}

function _sLC(c){var i=document.getElementById('lcI'),p=document.getElementById('lcP'),t=document.getElementById('lnT');if(c==='i'){if(i){i.classList.add('btn-purple');p.classList.remove('btn-purple');}if(t)t.value='conventional';}else{if(p){p.classList.add('btn-purple');i.classList.remove('btn-purple');}if(t)t.value='private';}}
function _lnCalc(){var price=parseFloat((document.getElementById('lnCalcPrice')||{}).value)||0;var down=parseFloat((document.getElementById('lnCalcDown')||{}).value)||20;var rate=parseFloat((document.getElementById('lnCalcRate')||{}).value)||7;var term=parseInt((document.getElementById('lnCalcTerm')||{}).value)||30;if(!price)return;var loan=Math.round(price*(1-down/100));var mo=Math.round(_calcPmt(loan,rate,term*12));var totalInt=mo*term*12-loan;var el=document.getElementById('lnCalcResult');if(el)el.innerHTML='Loan: <strong>$'+loan.toLocaleString()+'</strong> · P&I: <strong style="color:var(--accent);">$'+mo.toLocaleString()+'/mo</strong> · Total interest: <strong style="color:var(--danger);">$'+totalInt.toLocaleString()+'</strong>';}
function _lnCalcApply(){var price=parseFloat((document.getElementById('lnCalcPrice')||{}).value)||0;var down=parseFloat((document.getElementById('lnCalcDown')||{}).value)||20;var rate=parseFloat((document.getElementById('lnCalcRate')||{}).value)||7;var term=parseInt((document.getElementById('lnCalcTerm')||{}).value)||30;if(!price)return;var loan=Math.round(price*(1-down/100));var mo=Math.round(_calcPmt(loan,rate,term*12));var s=function(id,v){var e=document.getElementById(id);if(e)e.value=v;};s('lnA',loan);s('lnB',loan);s('lnR',rate);s('lnM',term*12);s('lnP',mo);}
async function _lnPopProps(sel){try{var d=await api('/api/properties');var s=document.getElementById('lnPr');if(!s)return;(d.properties||d||[]).filter(function(p){return!p.is_research;}).forEach(function(p){var o=document.createElement('option');o.value=p.id;o.textContent=(p.unit_number?p.unit_number+' · ':'')+(p.platform_listing_name||p.name||p.address||'#'+p.id);if(sel&&String(p.id)===String(sel))o.selected=true;s.appendChild(o);});}catch(e){}}

async function _saveLoan(editId){
  var g=function(id){var e=document.getElementById(id);return e?e.value:'';};
  var b={lender_name:g('lnN').trim(),lender_type:g('lnT'),loan_amount:parseFloat(g('lnA'))||0,current_balance:g('lnB')!==''?parseFloat(g('lnB')):null,interest_rate:parseFloat(g('lnR'))||0,term_months:g('lnM')?parseInt(g('lnM')):null,monthly_payment:parseFloat(g('lnP'))||0,payment_type:g('lnPT'),start_date:g('lnSD')||null,maturity_date:g('lnMD')||null,balloon_amount:g('lnBA')?parseFloat(g('lnBA')):null,balloon_date:g('lnBD')||null,property_id:g('lnPr')?parseInt(g('lnPr')):null,purpose:g('lnPu')||null,status:g('lnSt')||'active',collateral:g('lnCo').trim()||null,notes:g('lnNo').trim()||null};
  if(!b.lender_name||!b.loan_amount){alert('Lender name and loan amount are required.');return;}
  if(b.current_balance===null&&!editId)b.current_balance=b.loan_amount;
  try{if(editId){await api('/api/loans/'+editId,'PUT',b);}else{await api('/api/loans','POST',b);}var m=document.getElementById('loanFormModal');if(m)m.remove();loadPrivateLoansTab();}catch(e){alert('Error: '+e.message);}
}

async function _delLoan(id,name){if(!confirm('Delete loan "'+name+'"? All payment history will be deleted.'))return;try{await api('/api/loans/'+id,'DELETE');loadPrivateLoansTab();}catch(e){alert('Error: '+e.message);}}

// ═══ LOAN DETAIL MODAL — the rich view ═══
async function showLoanModal(id) {
  // Show loading overlay
  var overlay = '<div id="loanDetailModal" style="position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;padding:16px;" onclick="if(event.target===this)this.remove()"><div style="background:var(--surface);border-radius:12px;width:100%;max-width:700px;max-height:92vh;overflow-y:auto;border:1px solid var(--border);padding:24px;"><div style="text-align:center;padding:30px;"><div class="spinner"></div></div></div></div>';
  document.body.insertAdjacentHTML('beforeend', overlay);
  try {
    var d = await api('/api/loans/' + id);
    _renderLoanModal(d);
  } catch (err) {
    var modal = document.getElementById('loanDetailModal');
    if (modal) modal.querySelector('div > div').innerHTML = '<p style="color:var(--danger);padding:12px;">Error: ' + esc(err.message) + '</p>';
  }
}

function _renderLoanModal(d) {
  var l = d.loan, payments = d.payments || [], schedule = d.schedule || [];
  var bal = l.current_balance != null ? l.current_balance : l.loan_amount;
  var principalPaid = (l.loan_amount || 0) - bal;
  var paidPct = l.loan_amount > 0 ? Math.round((principalPaid / l.loan_amount) * 100) : 0;

  // Smart analytics
  var totalPaidAmt = payments.reduce(function(s,p){return s+(p.amount||0);},0);
  var totalIntPaid = payments.reduce(function(s,p){return s+(p.interest_portion||0);},0);
  var totalPrinPaid = payments.reduce(function(s,p){return s+(p.principal_portion||0);},0);
  var monthsElapsed = 0, projectedPayoff = '—', monthsRemaining = '—';
  if (l.start_date) {
    var start = new Date(l.start_date+'T00:00:00');
    var now = new Date();
    monthsElapsed = Math.max(0, (now.getFullYear()-start.getFullYear())*12+(now.getMonth()-start.getMonth()));
  }
  if (l.monthly_payment > 0 && bal > 0 && l.interest_rate > 0) {
    var mr = l.interest_rate/100/12;
    var moInt = bal * mr;
    var moPrin = l.monthly_payment - moInt;
    if (moPrin > 0) {
      var moRem = Math.ceil(Math.log(l.monthly_payment/(l.monthly_payment-bal*mr))/Math.log(1+mr));
      if (moRem > 0 && moRem < 9999) {
        monthsRemaining = moRem;
        var payoffDate = new Date();
        payoffDate.setMonth(payoffDate.getMonth()+moRem);
        projectedPayoff = payoffDate.toISOString().substring(0,7);
      }
    }
  } else if (l.monthly_payment > 0 && bal > 0 && (l.interest_rate||0) === 0) {
    monthsRemaining = Math.ceil(bal / l.monthly_payment);
    var pd = new Date(); pd.setMonth(pd.getMonth()+monthsRemaining);
    projectedPayoff = pd.toISOString().substring(0,7);
  }
  var totalCostOfLoan = schedule.length > 0 ? schedule.reduce(function(s,r){return s+r.interest;},0) : 0;

  var h = '';
  // Header
  h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">';
  h += '<h3 style="margin:0;display:flex;align-items:center;gap:8px;">' + _ico(_isInst(l.lender_type)?'building':'handCoins',20) + ' ' + esc(l.lender_name) + ' ' + _lBadge(l.lender_type) + '</h3>';
  h += '<div style="display:flex;gap:6px;"><button class="btn btn-xs" onclick="showLoanForm(' + l.id + ');document.getElementById(\'loanDetailModal\').remove()">Edit</button><button class="btn btn-xs" onclick="document.getElementById(\'loanDetailModal\').remove()">✕ Close</button></div>';
  h += '</div>';

  // KPI row
  h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(105px,1fr));gap:8px;margin-bottom:16px;">';
  h += _lc('Original','$'+(l.loan_amount||0).toLocaleString(),'dollarSign','var(--accent)');
  h += _lc('Balance','$'+bal.toLocaleString(),'receipt',bal>0?'#ef4444':'#10b981');
  h += _lc('Rate',(l.interest_rate||0)+'%','trendUp','#8b5cf6');
  h += _lc('Payment','$'+(l.monthly_payment||0).toLocaleString()+'/mo','calendar','#f59e0b');
  h += _lc('Paid Off',paidPct+'%','check','#10b981');
  if(typeof monthsRemaining==='number') h += _lc('Months Left',monthsRemaining,'clock','#3b82f6');
  h += '</div>';

  // Progress bar
  h += '<div style="margin-bottom:16px;"><div style="display:flex;justify-content:space-between;font-size:0.72rem;color:var(--text3);margin-bottom:4px;"><span>Payoff Progress</span><span>$'+principalPaid.toLocaleString()+' of $'+(l.loan_amount||0).toLocaleString()+'</span></div>';
  h += '<div style="background:var(--surface2);border-radius:6px;height:16px;overflow:hidden;border:1px solid var(--border);position:relative;">';
  h += '<div style="height:100%;background:linear-gradient(90deg,#10b981,#3b82f6);width:'+Math.min(100,paidPct)+'%;border-radius:6px;transition:width 0.5s;"></div>';
  h += '<div style="position:absolute;top:0;left:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;font-size:0.65rem;font-weight:700;color:white;text-shadow:0 0 3px rgba(0,0,0,0.5);">'+paidPct+'%</div>';
  h += '</div></div>';

  // Smart insights row
  h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:16px;font-size:0.78rem;">';
  h += '<div style="background:var(--surface2);border-radius:6px;padding:10px;border:1px solid var(--border);"><div style="font-size:0.65rem;color:var(--text3);text-transform:uppercase;">Total Paid</div><div style="font-weight:700;font-family:DM Mono,monospace;">$'+totalPaidAmt.toLocaleString()+'</div><div style="font-size:0.65rem;color:var(--text3);">'+payments.length+' payments</div></div>';
  h += '<div style="background:var(--surface2);border-radius:6px;padding:10px;border:1px solid var(--border);"><div style="font-size:0.65rem;color:var(--text3);text-transform:uppercase;">Interest Paid</div><div style="font-weight:700;font-family:DM Mono,monospace;color:#f59e0b;">$'+totalIntPaid.toLocaleString()+'</div><div style="font-size:0.65rem;color:var(--text3);">of total payments</div></div>';
  h += '<div style="background:var(--surface2);border-radius:6px;padding:10px;border:1px solid var(--border);"><div style="font-size:0.65rem;color:var(--text3);text-transform:uppercase;">Principal Paid</div><div style="font-weight:700;font-family:DM Mono,monospace;color:#10b981;">$'+totalPrinPaid.toLocaleString()+'</div><div style="font-size:0.65rem;color:var(--text3);">equity gained</div></div>';
  if(projectedPayoff!=='—') h += '<div style="background:var(--surface2);border-radius:6px;padding:10px;border:1px solid var(--border);"><div style="font-size:0.65rem;color:var(--text3);text-transform:uppercase;">Projected Payoff</div><div style="font-weight:700;font-family:DM Mono,monospace;color:#3b82f6;">'+projectedPayoff+'</div><div style="font-size:0.65rem;color:var(--text3);">at current payment</div></div>';
  if(totalCostOfLoan>0) h += '<div style="background:var(--surface2);border-radius:6px;padding:10px;border:1px solid var(--border);"><div style="font-size:0.65rem;color:var(--text3);text-transform:uppercase;">Total Interest Cost</div><div style="font-weight:700;font-family:DM Mono,monospace;color:var(--danger);">$'+Math.round(totalCostOfLoan).toLocaleString()+'</div><div style="font-size:0.65rem;color:var(--text3);">over loan lifetime</div></div>';
  if(monthsElapsed>0) h += '<div style="background:var(--surface2);border-radius:6px;padding:10px;border:1px solid var(--border);"><div style="font-size:0.65rem;color:var(--text3);text-transform:uppercase;">Months Elapsed</div><div style="font-weight:700;font-family:DM Mono,monospace;">'+monthsElapsed+'</div><div style="font-size:0.65rem;color:var(--text3);">since '+l.start_date+'</div></div>';
  h += '</div>';

  // Loan details
  var details = [];
  if(l.purpose) details.push(['Purpose',esc((l.purpose||'').replace(/_/g,' '))]);
  if(l.collateral) details.push(['Collateral',esc(l.collateral)]);
  if(l.property_name) details.push(['Property',esc((l.unit_number?l.unit_number+' · ':'')+l.property_name)]);
  if(l.payment_type) details.push(['Payment Type',esc((l.payment_type||'').replace(/_/g,' '))]);
  if(l.start_date) details.push(['Start Date',l.start_date]);
  if(l.maturity_date) details.push(['Maturity',l.maturity_date]);
  if(l.term_months) details.push(['Term',_tLbl(l.term_months)]);
  if(l.balloon_amount) details.push(['Balloon','$'+(l.balloon_amount||0).toLocaleString()+(l.balloon_date?' due '+l.balloon_date:'')]);
  if(l.notes) details.push(['Notes',esc(l.notes)]);
  if(details.length>0){
    h+='<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:6px 14px;margin-bottom:16px;font-size:0.78rem;">';
    details.forEach(function(d){h+='<div><span style="color:var(--text3);">'+d[0]+':</span> '+d[1]+'</div>';});
    h+='</div>';
  }

  // Record payment
  h+='<div style="padding:12px;background:var(--surface2);border-radius:8px;border:1px solid var(--border);margin-bottom:16px;">';
  h+='<div style="font-size:0.82rem;font-weight:600;margin-bottom:8px;">'+_ico('dollarSign',14)+' Record Payment</div>';
  h+='<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:end;">';
  h+='<div><label style="font-size:0.65rem;color:var(--text3);">Date</label><input id="lpD" type="date" value="'+new Date().toISOString().substring(0,10)+'" style="padding:6px 8px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:0.78rem;"></div>';
  h+='<div><label style="font-size:0.65rem;color:var(--text3);">Amount</label><input id="lpA" type="number" step="any" value="'+(l.monthly_payment||'')+'" style="padding:6px 8px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:0.78rem;width:100px;"></div>';
  h+='<div><label style="font-size:0.65rem;color:var(--text3);">Notes</label><input id="lpN" type="text" placeholder="Optional" style="padding:6px 8px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:0.78rem;width:120px;"></div>';
  h+='<button class="btn btn-xs btn-purple" onclick="_recPmt('+l.id+')">Record</button></div></div>';

  // Payment history
  h+='<div style="margin-bottom:16px;"><div style="font-size:0.82rem;font-weight:600;margin-bottom:8px;">'+_ico('clock',14)+' Payment History ('+payments.length+')</div>';
  if(payments.length>0){
    h+='<div style="overflow-x:auto;max-height:250px;overflow-y:auto;"><table class="comp-table" style="font-size:0.75rem;width:100%;"><thead style="position:sticky;top:0;background:var(--surface);"><tr><th>Date</th><th>Amount</th><th>Principal</th><th>Interest</th><th>Notes</th><th></th></tr></thead><tbody>';
    payments.forEach(function(p){h+='<tr><td>'+p.payment_date+'</td><td style="font-family:DM Mono,monospace;font-weight:600;">$'+(p.amount||0).toLocaleString()+'</td><td style="font-family:DM Mono,monospace;color:#10b981;">$'+(p.principal_portion||0).toLocaleString()+'</td><td style="font-family:DM Mono,monospace;color:#f59e0b;">$'+(p.interest_portion||0).toLocaleString()+'</td><td style="font-size:0.68rem;color:var(--text3);">'+esc(p.notes||'')+'</td><td><button class="btn btn-xs" style="color:var(--danger);font-size:0.65rem;" onclick="_delPmt('+l.id+','+p.id+')">×</button></td></tr>';});
    h+='</tbody></table></div>';
  } else {h+='<div style="text-align:center;color:var(--text3);padding:12px;font-size:0.78rem;">No payments recorded yet.</div>';}
  h+='</div>';

  // Amortization schedule
  if(schedule.length>0){
    h+='<details><summary style="cursor:pointer;font-size:0.82rem;font-weight:600;padding:8px 0;">'+_ico('barChart',14)+' Amortization Schedule ('+schedule.length+' months)</summary>';
    h+='<div style="overflow-x:auto;max-height:300px;overflow-y:auto;"><table class="comp-table" style="font-size:0.7rem;width:100%;"><thead style="position:sticky;top:0;background:var(--surface);"><tr><th>#</th><th>Date</th><th>Payment</th><th>Principal</th><th>Interest</th><th>Balance</th></tr></thead><tbody>';
    schedule.forEach(function(s){h+='<tr><td>'+s.month+'</td><td>'+s.date+'</td><td style="font-family:DM Mono,monospace;">$'+s.payment.toLocaleString()+'</td><td style="font-family:DM Mono,monospace;color:#10b981;">$'+s.principal.toLocaleString()+'</td><td style="font-family:DM Mono,monospace;color:#f59e0b;">$'+s.interest.toLocaleString()+'</td><td style="font-family:DM Mono,monospace;">$'+s.balance.toLocaleString()+'</td></tr>';});
    h+='</tbody></table></div></details>';
  }

  var modal = document.getElementById('loanDetailModal');
  if (modal) modal.querySelector('div > div').innerHTML = h;
}

async function _recPmt(loanId){var date=(document.getElementById('lpD')||{}).value;var amt=parseFloat((document.getElementById('lpA')||{}).value);var notes=((document.getElementById('lpN')||{}).value||'').trim();if(!date||!amt){alert('Date and amount required.');return;}try{await api('/api/loans/'+loanId+'/payments','POST',{payment_date:date,amount:amt,notes:notes||null});document.getElementById('loanDetailModal').remove();showLoanModal(loanId);loadPrivateLoansTab();}catch(e){alert('Error: '+e.message);}}
async function _delPmt(loanId,pmtId){if(!confirm('Delete this payment? Balance will be restored.'))return;try{await api('/api/loans/'+loanId+'/payments/'+pmtId,'DELETE');document.getElementById('loanDetailModal').remove();showLoanModal(loanId);loadPrivateLoansTab();}catch(e){alert('Error: '+e.message);}}
