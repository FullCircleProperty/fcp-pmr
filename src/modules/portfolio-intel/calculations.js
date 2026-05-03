/**
 * Portfolio Intelligence — Pure Calculation Functions
 * 
 * PORTABLE: No env, no DB, no side effects.
 * These functions take data in and return numbers.
 * Import into any JS project.
 */

// ── Core Financial Metrics ────────────────────────────────────────────────

/** Net Operating Income = Revenue - Operating Expenses (excludes mortgage/debt service) */
function calcNOI(annualRevenue, annualExpenses) {
  return (annualRevenue || 0) - (annualExpenses || 0);
}

/** Cap Rate = NOI / Property Value × 100 */
function calcCapRate(noi, propertyValue) {
  if (!propertyValue || propertyValue <= 0) return null;
  return (noi / propertyValue) * 100;
}

/** Cash-on-Cash Return = Annual Cash Flow / Total Cash Invested × 100 */
function calcCashOnCash(annualCashFlow, totalCashInvested) {
  if (!totalCashInvested || totalCashInvested <= 0) return null;
  return (annualCashFlow / totalCashInvested) * 100;
}

/** DSCR = NOI / Annual Debt Service (mortgage payments × 12) */
function calcDSCR(noi, monthlyMortgage) {
  const annualDebt = (monthlyMortgage || 0) * 12;
  if (annualDebt <= 0) return null; // No debt = infinite coverage
  return noi / annualDebt;
}

/** Gross Rent Multiplier = Property Value / Annual Gross Rent */
function calcGRM(propertyValue, annualRevenue) {
  if (!annualRevenue || annualRevenue <= 0) return null;
  return propertyValue / annualRevenue;
}

/** Monthly Cash Flow = Revenue - All Expenses (including mortgage) */
function calcMonthlyCashFlow(monthlyRevenue, monthlyExpenses, monthlyMortgage) {
  return (monthlyRevenue || 0) - (monthlyExpenses || 0) - (monthlyMortgage || 0);
}

/** Equity = Estimated Value - Remaining Loan Balance */
function calcEquity(estimatedValue, loanBalance) {
  return (estimatedValue || 0) - (loanBalance || 0);
}

/** LTV = Loan Balance / Property Value × 100 */
function calcLTV(loanBalance, propertyValue) {
  if (!propertyValue || propertyValue <= 0) return null;
  return ((loanBalance || 0) / propertyValue) * 100;
}

/** RevPAR = Revenue per Available Room-Night = Total Revenue / Available Nights */
function calcRevPAR(totalRevenue, availableNights) {
  if (!availableNights || availableNights <= 0) return null;
  return totalRevenue / availableNights;
}

/** Breakeven Occupancy = Monthly Expenses / (ADR × 30) × 100 */
function calcBreakevenOcc(monthlyExpenses, monthlyMortgage, adr) {
  const totalMonthly = (monthlyExpenses || 0) + (monthlyMortgage || 0);
  if (!adr || adr <= 0) return null;
  const breakevenNights = totalMonthly / adr;
  return Math.min(100, (breakevenNights / 30) * 100);
}

// ── Projection Engine ─────────────────────────────────────────────────────

/**
 * Project forward revenue using trailing actuals + growth rate
 * @param {Array} monthlyActuals - [{month:'2025-01', total_revenue:5000}, ...]
 * @param {number} months - How many months to project forward
 * @param {number} growthRate - Annual growth rate as decimal (0.05 = 5%)
 * @returns {Array} [{month, projected_revenue, basis}]
 */
function projectRevenue(monthlyActuals, months, growthRate) {
  if (!monthlyActuals || monthlyActuals.length === 0) return [];
  
  // Use trailing 12 months (or whatever we have) as seasonal template
  const sorted = [...monthlyActuals].sort((a, b) => a.month.localeCompare(b.month));
  const trail12 = sorted.slice(-12);
  
  // Build seasonal index (avg revenue by month-of-year)
  const byMonth = {};
  trail12.forEach(m => {
    const mo = m.month.slice(5, 7); // "01", "02", etc.
    if (!byMonth[mo]) byMonth[mo] = [];
    byMonth[mo].push(m.total_revenue || 0);
  });
  const seasonalAvg = {};
  Object.keys(byMonth).forEach(mo => {
    seasonalAvg[mo] = byMonth[mo].reduce((s, v) => s + v, 0) / byMonth[mo].length;
  });
  
  // Overall monthly average for filling gaps
  const overallAvg = trail12.reduce((s, m) => s + (m.total_revenue || 0), 0) / trail12.length;
  
  const lastMonth = sorted[sorted.length - 1].month;
  const projections = [];
  
  for (let i = 1; i <= months; i++) {
    const d = new Date(lastMonth + '-01');
    d.setMonth(d.getMonth() + i);
    const projMonth = d.toISOString().slice(0, 7);
    const mo = projMonth.slice(5, 7);
    const baseRevenue = seasonalAvg[mo] || overallAvg;
    const yearsOut = i / 12;
    const growthMultiplier = Math.pow(1 + (growthRate || 0), yearsOut);
    projections.push({
      month: projMonth,
      projected_revenue: Math.round(baseRevenue * growthMultiplier),
      basis: seasonalAvg[mo] ? 'seasonal' : 'average'
    });
  }
  
  return projections;
}

/**
 * Portfolio valuation using income approach (cap rate method)
 * @param {number} portfolioNOI - Total portfolio annual NOI
 * @param {number} marketCapRate - Market cap rate % (e.g., 7.5)
 * @returns {number} Estimated portfolio value
 */
function calcPortfolioValue(portfolioNOI, marketCapRate) {
  if (!marketCapRate || marketCapRate <= 0) return null;
  return portfolioNOI / (marketCapRate / 100);
}

/**
 * Scenario modeling: "What if we add a property?"
 * @param {Object} current - {annual_revenue, annual_expenses, annual_debt, total_equity, total_value}
 * @param {Object} acquisition - {purchase_price, down_payment_pct, interest_rate, loan_term, projected_adr, projected_occ, monthly_expenses}
 * @returns {Object} Combined portfolio metrics before/after
 */
function scenarioAddProperty(current, acquisition) {
  const downPmt = (acquisition.purchase_price || 0) * ((acquisition.down_payment_pct || 20) / 100);
  const loanAmt = (acquisition.purchase_price || 0) - downPmt;
  
  // Monthly mortgage payment (P&I)
  const r = ((acquisition.interest_rate || 7) / 100) / 12;
  const n = (acquisition.loan_term || 30) * 12;
  const monthlyPmt = r > 0 ? loanAmt * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1) : loanAmt / n;
  
  // New property projected annual revenue
  const projRevenue = (acquisition.projected_adr || 150) * (acquisition.projected_occ || 65) / 100 * 365;
  const projExpenses = (acquisition.monthly_expenses || 500) * 12;
  const newNOI = projRevenue - projExpenses;
  const newCashFlow = newNOI - (monthlyPmt * 12);
  
  return {
    before: {
      annual_revenue: current.annual_revenue || 0,
      annual_noi: (current.annual_revenue || 0) - (current.annual_expenses || 0),
      annual_cash_flow: (current.annual_revenue || 0) - (current.annual_expenses || 0) - (current.annual_debt || 0),
      total_equity: current.total_equity || 0,
      total_value: current.total_value || 0
    },
    acquisition: {
      purchase_price: acquisition.purchase_price,
      down_payment: downPmt,
      loan_amount: loanAmt,
      monthly_mortgage: Math.round(monthlyPmt),
      projected_annual_revenue: Math.round(projRevenue),
      projected_noi: Math.round(newNOI),
      projected_cash_flow: Math.round(newCashFlow),
      cap_rate: calcCapRate(newNOI, acquisition.purchase_price),
      cash_on_cash: calcCashOnCash(newCashFlow, downPmt)
    },
    after: {
      annual_revenue: (current.annual_revenue || 0) + Math.round(projRevenue),
      annual_noi: ((current.annual_revenue || 0) - (current.annual_expenses || 0)) + Math.round(newNOI),
      annual_cash_flow: ((current.annual_revenue || 0) - (current.annual_expenses || 0) - (current.annual_debt || 0)) + Math.round(newCashFlow),
      total_equity: (current.total_equity || 0) + downPmt,
      total_value: (current.total_value || 0) + (acquisition.purchase_price || 0)
    }
  };
}

/**
 * Calculate YoY growth rate from monthly actuals
 * @param {Array} monthlyActuals sorted by month ASC
 * @returns {number|null} Annual growth rate as decimal
 */
function calcYoYGrowth(monthlyActuals) {
  if (!monthlyActuals || monthlyActuals.length < 13) return null;
  const sorted = [...monthlyActuals].sort((a, b) => a.month.localeCompare(b.month));
  // Compare trailing 12 months vs prior 12 months
  const recent12 = sorted.slice(-12);
  const prior12 = sorted.slice(-24, -12);
  if (prior12.length < 6) return null; // need at least 6 months prior
  const recentTotal = recent12.reduce((s, m) => s + (m.total_revenue || 0), 0);
  const priorTotal = prior12.reduce((s, m) => s + (m.total_revenue || 0), 0);
  // Annualize if prior period is less than 12 months
  const annualizedPrior = priorTotal * (12 / prior12.length);
  if (annualizedPrior <= 0) return null;
  return (recentTotal - annualizedPrior) / annualizedPrior;
}

// Export for use in other modules
if (typeof module !== 'undefined') {
  module.exports = {
    calcNOI, calcCapRate, calcCashOnCash, calcDSCR, calcGRM,
    calcMonthlyCashFlow, calcEquity, calcLTV, calcRevPAR,
    calcBreakevenOcc, projectRevenue, calcPortfolioValue,
    scenarioAddProperty, calcYoYGrowth
  };
}
