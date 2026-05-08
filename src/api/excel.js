import ExcelJS from 'exceljs'
import { db } from '../processing/validator.js'

// ── Paleta de colores ──────────────────────────────────────────────────────
const C = {
  navyDark:   '0F2D4A',
  navy:       '1E3A5F',
  blue:       '2563EB',
  blueLt:     'DBEAFE',
  blueXlt:    'EFF6FF',
  green:      '16A34A',
  greenLt:    'DCFCE7',
  red:        'DC2626',
  redLt:      'FEF2F2',
  amber:      'D97706',
  amberLt:    'FFFBEB',
  gray:       '64748B',
  grayLt:     'F1F5F9',
  grayXlt:    'F8FAFC',
  border:     'CBD5E1',
  white:      'FFFFFF',
  text:       '0F172A',
}

const SYMS = { EUR: '€', USD: '$', DOP: 'RD$' }
const fmt = (n) => n == null ? '—' : Number(n).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtC = (n, cur) => n == null ? '—' : `${SYMS[cur] || ''}${fmt(n)}`
const fmtDate = (d) => {
  if (!d) return '—'
  try { return new Date(d + 'T00:00:00').toLocaleDateString('es-DO', { day: '2-digit', month: '2-digit', year: 'numeric' }) }
  catch { return d }
}
const monthLabel = (ym) => {
  if (!ym) return '—'
  try {
    const [y, m] = ym.split('-')
    return new Date(+y, +m - 1, 1).toLocaleDateString('es-DO', { month: 'long', year: 'numeric' })
  } catch { return ym }
}

// ── Helpers de estilo ──────────────────────────────────────────────────────
function fill(argb) { return { type: 'pattern', pattern: 'solid', fgColor: { argb } } }
function border(color = C.border) {
  const s = { style: 'thin', color: { argb: color } }
  return { top: s, left: s, bottom: s, right: s }
}
function borderBottom(color = C.navy) {
  return { bottom: { style: 'medium', color: { argb: color } } }
}

function applyTitle(cell, text, { bg = C.navyDark, fg = C.white, sz = 16, bold = true } = {}) {
  cell.value = text
  cell.font = { name: 'Calibri', size: sz, bold, color: { argb: fg } }
  cell.fill = fill(bg)
  cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: false }
}

function applySection(cell, text) {
  cell.value = text
  cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: C.white } }
  cell.fill = fill(C.navy)
  cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 }
}

function applyHeader(cell, text) {
  cell.value = text
  cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: C.white } }
  cell.fill = fill(C.blue)
  cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
  cell.border = border(C.white)
}

function applyLabel(cell, text, indent = 1) {
  cell.value = text
  cell.font = { name: 'Calibri', size: 10, color: { argb: C.text } }
  cell.alignment = { vertical: 'middle', horizontal: 'left', indent }
}

function applyValue(cell, value, { bold = false, color = C.text, numFmt = null, align = 'right' } = {}) {
  cell.value = value
  cell.font = { name: 'Calibri', size: 10, bold, color: { argb: color } }
  cell.alignment = { vertical: 'middle', horizontal: align }
  if (numFmt) cell.numFmt = numFmt
}

function applyTotal(cell, text, { bg = C.blueXlt, bold = true, color = C.navy } = {}) {
  cell.value = text
  cell.font = { name: 'Calibri', size: 10, bold, color: { argb: color } }
  cell.fill = fill(bg)
  cell.alignment = { vertical: 'middle', horizontal: 'right' }
}

function addBlankRow(sheet, cols = 1) {
  const row = sheet.addRow([])
  row.height = 6
}

// ── Helpers DB ─────────────────────────────────────────────────────────────
function getInvoices(currency) {
  const cf = currency ? ' AND currency = ?' : ''
  const cp = currency ? [currency] : []
  return db.prepare(`SELECT * FROM invoices WHERE 1=1${cf} ORDER BY created_at DESC`).all(...cp)
}

function getIncomeTable() {
  try { return db.prepare('SELECT * FROM income ORDER BY month DESC').all() }
  catch { return [] }
}

function getStatsByStatus(currency) {
  const cf = currency ? ' AND currency = ?' : ''
  const cp = currency ? [currency] : []
  return db.prepare(`SELECT status, COUNT(*) as count, COALESCE(SUM(total),0) as total, COALESCE(SUM(tax_amount),0) as tax FROM invoices WHERE 1=1${cf} GROUP BY status`).all(...cp)
}

function getStatsByCategory(currency) {
  const cf = currency ? ' AND currency = ?' : ''
  const cp = currency ? [currency] : []
  return db.prepare(`SELECT category, COUNT(*) as count, COALESCE(SUM(total),0) as total FROM invoices WHERE status != 'rejected'${cf} GROUP BY category ORDER BY total DESC`).all(...cp)
}

function getMonthlyTrend(currency) {
  const cf = currency ? ' AND currency = ?' : ''
  const cp = currency ? [currency] : []
  return db.prepare(`
    SELECT strftime('%Y-%m', created_at) as month,
           COUNT(*) as count,
           COALESCE(SUM(total),0) as expenses,
           COALESCE(SUM(tax_amount),0) as tax
    FROM invoices WHERE status != 'rejected'${cf}
    GROUP BY month ORDER BY month DESC LIMIT 12
  `).all(...cp)
}

// ── HOJA 1: Facturas ──────────────────────────────────────────────────────
function buildSheetFacturas(wb, invoices, currency) {
  const ws = wb.addWorksheet('📋 Facturas', { views: [{ state: 'frozen', ySplit: 5 }] })
  const sym = currency ? (SYMS[currency] || '') : ''
  const cols = 12

  ws.columns = [
    { key: 'num',     width: 5  },
    { key: 'date',    width: 13 },
    { key: 'invnum',  width: 20 },
    { key: 'vendor',  width: 30 },
    { key: 'cif',     width: 14 },
    { key: 'cat',     width: 22 },
    { key: 'sub',     width: 14 },
    { key: 'tax',     width: 13 },
    { key: 'total',   width: 14 },
    { key: 'cur',     width: 8  },
    { key: 'status',  width: 13 },
    { key: 'conf',    width: 11 },
  ]

  // Fila 1: Título principal
  ws.mergeCells('A1:L1')
  applyTitle(ws.getCell('A1'), '  REGISTRO DE FACTURAS', { sz: 18 })
  ws.getRow(1).height = 40

  // Fila 2: Subtítulo
  ws.mergeCells('A2:L2')
  const now = new Date()
  ws.getCell('A2').value = `Exportado el ${now.toLocaleDateString('es-DO', { day: '2-digit', month: 'long', year: 'numeric' })}${currency ? ` · Divisa: ${currency}` : ' · Todas las divisas'}`
  ws.getCell('A2').font = { name: 'Calibri', size: 10, italic: true, color: { argb: C.white } }
  ws.getCell('A2').fill = fill(C.navy)
  ws.getCell('A2').alignment = { horizontal: 'center', vertical: 'middle' }
  ws.getRow(2).height = 20

  // Fila 3: vacía decorativa
  ws.mergeCells('A3:L3')
  ws.getCell('A3').fill = fill(C.blueXlt)
  ws.getRow(3).height = 5

  // Fila 4: vacía
  ws.getRow(4).height = 4

  // Fila 5: Cabeceras
  const headers = ['#', 'Fecha', 'Nº Factura', 'Proveedor / Comercio', 'CIF / RNC', 'Categoría', `Base Imponible${sym ? ' ' + sym : ''}`, `ITBIS/IVA${sym ? ' ' + sym : ''}`, `Total${sym ? ' ' + sym : ''}`, 'Divisa', 'Estado', 'Confianza']
  const hRow = ws.getRow(5)
  hRow.height = 28
  headers.forEach((h, i) => applyHeader(hRow.getCell(i + 1), h))

  // Datos
  const statusLabel = { pending: 'Pendiente', approved: 'Aprobada', rejected: 'Rechazada' }
  const statusColor = { pending: C.amber, approved: C.green, rejected: C.red }

  invoices.forEach((inv, idx) => {
    const row = ws.addRow([])
    row.height = 20
    const isAlt = idx % 2 === 1
    const rowBg = isAlt ? C.grayXlt : C.white

    const cells = [
      [idx + 1, { align: 'center' }],
      [fmtDate(inv.date || inv.created_at), { align: 'center' }],
      [inv.invoice_number || '—', { align: 'center' }],
      [inv.vendor || '—', { align: 'left' }],
      [inv.vendor_cif || '—', { align: 'center' }],
      [inv.category || '—', { align: 'left' }],
      [inv.subtotal != null ? inv.subtotal : '—', { align: 'right', numFmt: inv.subtotal != null ? '#,##0.00' : null }],
      [inv.tax_amount != null ? inv.tax_amount : '—', { align: 'right', numFmt: inv.tax_amount != null ? '#,##0.00' : null }],
      [inv.total != null ? inv.total : '—', { align: 'right', bold: true, numFmt: inv.total != null ? '#,##0.00' : null }],
      [inv.currency || '—', { align: 'center' }],
      [statusLabel[inv.status] || inv.status, { align: 'center', color: statusColor[inv.status] || C.gray, bold: true }],
      [inv.confidence != null ? `${Math.round(inv.confidence * 100)}%` : '—', { align: 'center', color: inv.confidence >= 0.9 ? C.green : inv.confidence >= 0.7 ? C.amber : C.red }],
    ]

    cells.forEach(([val, opts], ci) => {
      const cell = row.getCell(ci + 1)
      cell.value = val
      cell.font = { name: 'Calibri', size: 10, bold: opts.bold || false, color: { argb: opts.color || C.text } }
      cell.fill = fill(rowBg)
      cell.alignment = { vertical: 'middle', horizontal: opts.align || 'left', wrapText: false }
      if (opts.numFmt) cell.numFmt = opts.numFmt
      cell.border = { bottom: { style: 'hair', color: { argb: C.border } } }
    })
  })

  // Fila de total
  addBlankRow(ws)
  const totRow = ws.addRow([])
  totRow.height = 22
  ws.mergeCells(`A${totRow.number}:F${totRow.number}`)
  applyTotal(ws.getCell(`A${totRow.number}`), `TOTAL — ${invoices.length} facturas`, { bg: C.blueLt })
  ws.getCell(`A${totRow.number}`).alignment = { horizontal: 'right', vertical: 'middle' }

  const totalSum = invoices.reduce((s, i) => s + (i.total || 0), 0)
  const taxSum   = invoices.reduce((s, i) => s + (i.tax_amount || 0), 0)
  const subSum   = invoices.reduce((s, i) => s + (i.subtotal || 0), 0)

  ;[
    ['G', subSum],
    ['H', taxSum],
    ['I', totalSum],
  ].forEach(([col, val]) => {
    const cell = ws.getCell(`${col}${totRow.number}`)
    cell.value = val
    cell.numFmt = '#,##0.00'
    cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: C.navy } }
    cell.fill = fill(C.blueLt)
    cell.alignment = { horizontal: 'right', vertical: 'middle' }
    cell.border = { top: { style: 'medium', color: { argb: C.navy } } }
  })

  return ws
}

// ── HOJA 2: Estado de Resultados ──────────────────────────────────────────
function buildSheetEstadoResultados(wb, currency) {
  const ws = wb.addWorksheet('📊 Estado de Resultados', { views: [{ state: 'normal' }] })
  const cols = 5

  ws.columns = [
    { key: 'a', width: 35 },
    { key: 'b', width: 18 },
    { key: 'c', width: 18 },
    { key: 'd', width: 18 },
    { key: 'e', width: 18 },
  ]

  const now = new Date()
  const curMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const prevMonth = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`

  // Función para obtener ingresos del mes
  const getIncomeForMonth = (month, cur) => {
    try {
      const r = db.prepare('SELECT amount FROM income WHERE month = ? AND currency = ?').get(month, cur || 'DOP')
      return r?.amount || 0
    } catch { return 0 }
  }

  // Gastos del mes
  const getExpensesForMonth = (month, cur) => {
    const cf = cur ? ' AND currency = ?' : ''
    const cp = cur ? [month, cur] : [month]
    const r = db.prepare(`SELECT COALESCE(SUM(total),0) as t, COALESCE(SUM(tax_amount),0) as tax FROM invoices WHERE strftime('%Y-%m', created_at) = ?${cf} AND status != 'rejected'`).get(...cp)
    return { expenses: r.t, tax: r.tax }
  }

  const curSym = currency ? (SYMS[currency] || '') : ''
  const numFmt = '#,##0.00'

  // ── TÍTULO
  ws.mergeCells('A1:E1')
  applyTitle(ws.getCell('A1'), 'ESTADO DE RESULTADOS', { sz: 18 })
  ws.getRow(1).height = 40

  ws.mergeCells('A2:E2')
  ws.getCell('A2').value = `Período: ${monthLabel(curMonth)}${currency ? ` · Divisa: ${currency}` : ''}`
  ws.getCell('A2').font = { name: 'Calibri', size: 10, italic: true, color: { argb: C.white } }
  ws.getCell('A2').fill = fill(C.navy)
  ws.getCell('A2').alignment = { horizontal: 'center', vertical: 'middle' }
  ws.getRow(2).height = 20

  ws.mergeCells('A3:E3')
  ws.getCell('A3').fill = fill(C.blueXlt)
  ws.getRow(3).height = 6

  // ── MES ACTUAL
  addBlankRow(ws)

  const addSectionHeader = (label) => {
    const r = ws.addRow([])
    ws.mergeCells(`A${r.number}:E${r.number}`)
    applySection(ws.getCell(`A${r.number}`), `  ${label}`)
    r.height = 24
    return r
  }

  const addDataRow = (label, value, { bg = C.white, bold = false, color = C.text, isTotal = false } = {}) => {
    const r = ws.addRow([])
    r.height = 20
    const bgFill = fill(isTotal ? C.blueXlt : bg)

    const lc = r.getCell(1)
    lc.value = label
    lc.font = { name: 'Calibri', size: 10, bold: bold || isTotal, color: { argb: isTotal ? C.navy : C.text } }
    lc.fill = bgFill
    lc.alignment = { horizontal: 'left', vertical: 'middle', indent: isTotal ? 0 : 2 }

    const vc = r.getCell(2)
    vc.value = typeof value === 'number' ? value : null
    vc.font = { name: 'Calibri', size: 10, bold: bold || isTotal, color: { argb: color || (isTotal ? C.navy : C.text) } }
    vc.fill = bgFill
    vc.alignment = { horizontal: 'right', vertical: 'middle' }
    if (typeof value === 'number') vc.numFmt = numFmt
    else vc.value = value

    if (isTotal) {
      for (let c = 1; c <= 5; c++) {
        const cell = r.getCell(c)
        cell.border = {
          top: { style: 'thin', color: { argb: C.navy } },
          bottom: { style: 'medium', color: { argb: C.navy } },
        }
      }
    } else {
      r.getCell(1).border = { bottom: { style: 'hair', color: { argb: C.border } } }
      r.getCell(2).border = { bottom: { style: 'hair', color: { argb: C.border } } }
    }

    ws.mergeCells(`B${r.number}:E${r.number}`)
    return r
  }

  // ── INGRESOS del mes actual
  addSectionHeader(`INGRESOS — ${monthLabel(curMonth)}`)
  const curIncome = currency ? getIncomeForMonth(curMonth, currency) : 0
  addDataRow('Ingresos registrados del mes', curIncome, { color: C.green, bold: curIncome > 0 })
  addDataRow('TOTAL INGRESOS', curIncome, { isTotal: true, color: C.green })

  addBlankRow(ws)

  // ── GASTOS por categoría del mes actual
  addSectionHeader(`GASTOS POR CATEGORÍA — ${monthLabel(curMonth)}`)
  const cf = currency ? ' AND currency = ?' : ''
  const cp = currency ? [curMonth, currency] : [curMonth]
  const catRows = db.prepare(`
    SELECT category, COUNT(*) as cnt, COALESCE(SUM(total),0) as total
    FROM invoices
    WHERE strftime('%Y-%m', created_at) = ?${cf} AND status != 'rejected'
    GROUP BY category ORDER BY total DESC
  `).all(...cp)

  let totalGastos = 0
  catRows.forEach((c, i) => {
    totalGastos += c.total
    addDataRow(c.category || 'Sin categoría', c.total, { bg: i % 2 === 1 ? C.grayXlt : C.white })
  })
  if (catRows.length === 0) addDataRow('Sin gastos registrados este mes', '—')

  const { tax: curTax } = getExpensesForMonth(curMonth, currency)
  addDataRow('— del cual: ITBIS/IVA incluido', curTax, { color: C.gray })
  addDataRow('TOTAL GASTOS', totalGastos, { isTotal: true, color: C.red })

  addBlankRow(ws)

  // ── RESULTADO NETO
  addSectionHeader('RESULTADO NETO')
  const netResult = curIncome - totalGastos
  const marginPct = curIncome > 0 ? ((netResult / curIncome) * 100).toFixed(1) : '—'
  addDataRow(netResult >= 0 ? '✓ Beneficio Neto' : '↓ Pérdida Neta', netResult, {
    bold: true,
    color: netResult >= 0 ? C.green : C.red,
    bg: netResult >= 0 ? C.greenLt : C.redLt,
    isTotal: true,
  })
  addDataRow('Margen sobre ingresos', typeof marginPct === 'number' || marginPct !== '—' ? `${marginPct}%` : '—')

  addBlankRow(ws)

  // ── TENDENCIA ÚLTIMOS 6 MESES
  addSectionHeader('TENDENCIA — ÚLTIMOS 6 MESES')

  // Cabecera de tabla de tendencia
  const tHdr = ws.addRow([])
  tHdr.height = 22
  ;['Mes', 'Ingresos', 'Gastos', 'ITBIS/IVA', 'Resultado'].forEach((h, i) => applyHeader(tHdr.getCell(i + 1), h))

  const trend = getMonthlyTrend(currency)
  trend.forEach((t, i) => {
    const inc = currency ? getIncomeForMonth(t.month, currency) : 0
    const net = inc - t.expenses
    const r = ws.addRow([])
    r.height = 20
    const bg = i % 2 === 1 ? C.grayXlt : C.white

    ;[
      [monthLabel(t.month), { align: 'left' }],
      [inc, { align: 'right', numFmt, color: C.green }],
      [t.expenses, { align: 'right', numFmt, color: C.red }],
      [t.tax, { align: 'right', numFmt }],
      [net, { align: 'right', numFmt, bold: true, color: net >= 0 ? C.green : C.red }],
    ].forEach(([val, opts], ci) => {
      const cell = r.getCell(ci + 1)
      cell.value = val
      cell.font = { name: 'Calibri', size: 10, bold: opts.bold || false, color: { argb: opts.color || C.text } }
      cell.fill = fill(bg)
      cell.alignment = { horizontal: opts.align, vertical: 'middle' }
      if (opts.numFmt && typeof val === 'number') cell.numFmt = opts.numFmt
      cell.border = { bottom: { style: 'hair', color: { argb: C.border } } }
    })
  })

  return ws
}

// ── HOJA 3: Balance General ───────────────────────────────────────────────
function buildSheetBalance(wb, currency) {
  const ws = wb.addWorksheet('⚖️ Balance General', { views: [{ state: 'normal' }] })

  ws.columns = [
    { key: 'a', width: 30 },
    { key: 'b', width: 12 },
    { key: 'c', width: 18 },
    { key: 'd', width: 18 },
    { key: 'e', width: 18 },
  ]

  const now = new Date()
  const numFmt = '#,##0.00'
  const curSym = currency ? (SYMS[currency] || '') : ''

  ws.mergeCells('A1:E1')
  applyTitle(ws.getCell('A1'), 'BALANCE GENERAL', { sz: 18 })
  ws.getRow(1).height = 40

  ws.mergeCells('A2:E2')
  ws.getCell('A2').value = `Al ${now.toLocaleDateString('es-DO', { day: '2-digit', month: 'long', year: 'numeric' })}${currency ? ` · Divisa: ${currency}` : ' · Todas las divisas'}`
  ws.getCell('A2').font = { name: 'Calibri', size: 10, italic: true, color: { argb: C.white } }
  ws.getCell('A2').fill = fill(C.navy)
  ws.getCell('A2').alignment = { horizontal: 'center', vertical: 'middle' }
  ws.getRow(2).height = 20

  ws.mergeCells('A3:E3')
  ws.getCell('A3').fill = fill(C.blueXlt)
  ws.getRow(3).height = 6

  const addSec = (label) => {
    addBlankRow(ws)
    const r = ws.addRow([])
    ws.mergeCells(`A${r.number}:E${r.number}`)
    applySection(ws.getCell(`A${r.number}`), `  ${label}`)
    r.height = 24

    const hdr = ws.addRow([])
    hdr.height = 22
    return hdr
  }

  // ── RESUMEN GLOBAL
  const statRows = getStatsByStatus(currency)
  const totals = { count: 0, total: 0, tax: 0 }
  statRows.forEach(s => { totals.count += s.count; totals.total += s.total; totals.tax += s.tax })

  const hdr1 = addSec('RESUMEN GLOBAL DE FACTURAS')
  ;['Estado', 'Facturas', `Total ${curSym}`, `ITBIS/IVA ${curSym}`, '% del total'].forEach((h, i) => applyHeader(hdr1.getCell(i + 1), h))

  const statusLabel = { pending: 'Pendiente', approved: 'Aprobada', rejected: 'Rechazada' }
  const statusBg = { pending: C.amberLt, approved: C.greenLt, rejected: C.redLt }
  const statusCol = { pending: C.amber, approved: C.green, rejected: C.red }

  statRows.forEach(s => {
    const r = ws.addRow([])
    r.height = 20
    const pct = totals.total > 0 ? ((s.total / totals.total) * 100).toFixed(1) + '%' : '—'
    const cells = [
      [statusLabel[s.status] || s.status, 'left', null, true, statusCol[s.status]],
      [s.count, 'center', null, false, null],
      [s.total, 'right', numFmt, true, statusCol[s.status]],
      [s.tax, 'right', numFmt, false, null],
      [pct, 'center', null, false, C.gray],
    ]
    cells.forEach(([val, align, nf, bold, color], ci) => {
      const cell = r.getCell(ci + 1)
      cell.value = val
      cell.font = { name: 'Calibri', size: 10, bold: !!bold, color: { argb: color || C.text } }
      cell.fill = fill(statusBg[s.status] || C.white)
      cell.alignment = { horizontal: align, vertical: 'middle' }
      if (nf && typeof val === 'number') cell.numFmt = nf
      cell.border = { bottom: { style: 'hair', color: { argb: C.border } } }
    })
  })

  // Total global
  const totR = ws.addRow([])
  totR.height = 22
  ;[
    ['TOTAL GENERAL', 'right', null, true, C.navy, C.blueLt],
    [totals.count, 'center', null, true, C.navy, C.blueLt],
    [totals.total, 'right', numFmt, true, C.navy, C.blueLt],
    [totals.tax, 'right', numFmt, true, C.navy, C.blueLt],
    ['100%', 'center', null, true, C.navy, C.blueLt],
  ].forEach(([val, align, nf, bold, color, bg], ci) => {
    const cell = totR.getCell(ci + 1)
    cell.value = val
    cell.font = { name: 'Calibri', size: 10, bold, color: { argb: color } }
    cell.fill = fill(bg)
    cell.alignment = { horizontal: align, vertical: 'middle' }
    if (nf && typeof val === 'number') cell.numFmt = nf
    cell.border = { top: { style: 'medium', color: { argb: C.navy } } }
  })

  // ── POR CATEGORÍA
  const catRows = getStatsByCategory(currency)
  const hdr2 = addSec('DESGLOSE POR CATEGORÍA')
  ;['Categoría', 'Facturas', `Total ${curSym}`, `Promedio ${curSym}`, '% del gasto'].forEach((h, i) => applyHeader(hdr2.getCell(i + 1), h))

  const catTotal = catRows.reduce((s, c) => s + c.total, 0)
  catRows.forEach((c, i) => {
    const r = ws.addRow([])
    r.height = 20
    const avg = c.count > 0 ? c.total / c.count : 0
    const pct = catTotal > 0 ? ((c.total / catTotal) * 100).toFixed(1) + '%' : '—'
    const bg = i % 2 === 1 ? C.grayXlt : C.white
    ;[
      [c.category || 'Sin categoría', 'left', null],
      [c.count, 'center', null],
      [c.total, 'right', numFmt],
      [avg, 'right', numFmt],
      [pct, 'center', null],
    ].forEach(([val, align, nf], ci) => {
      const cell = r.getCell(ci + 1)
      cell.value = val
      cell.font = { name: 'Calibri', size: 10, color: { argb: C.text } }
      cell.fill = fill(bg)
      cell.alignment = { horizontal: align, vertical: 'middle' }
      if (nf && typeof val === 'number') cell.numFmt = nf
      cell.border = { bottom: { style: 'hair', color: { argb: C.border } } }
    })
  })

  // ── TOP PROVEEDORES
  const cf2 = currency ? ' AND currency = ?' : ''
  const cp2 = currency ? [currency] : []
  const vendors = db.prepare(`
    SELECT vendor, COUNT(*) as cnt, COALESCE(SUM(total),0) as total
    FROM invoices WHERE status != 'rejected' AND vendor IS NOT NULL${cf2}
    GROUP BY vendor ORDER BY total DESC LIMIT 10
  `).all(...cp2)

  const hdr3 = addSec('TOP 10 PROVEEDORES POR GASTO')
  ;['Proveedor', 'Facturas', `Total ${curSym}`, `Promedio ${curSym}`, '% del gasto'].forEach((h, i) => applyHeader(hdr3.getCell(i + 1), h))

  const vendorTotal = vendors.reduce((s, v) => s + v.total, 0)
  vendors.forEach((v, i) => {
    const r = ws.addRow([])
    r.height = 20
    const avg = v.cnt > 0 ? v.total / v.cnt : 0
    const pct = vendorTotal > 0 ? ((v.total / vendorTotal) * 100).toFixed(1) + '%' : '—'
    const bg = i % 2 === 1 ? C.grayXlt : C.white
    ;[
      [v.vendor, 'left', null],
      [v.cnt, 'center', null],
      [v.total, 'right', numFmt],
      [avg, 'right', numFmt],
      [pct, 'center', null],
    ].forEach(([val, align, nf], ci) => {
      const cell = r.getCell(ci + 1)
      cell.value = val
      cell.font = { name: 'Calibri', size: 10, color: { argb: C.text } }
      cell.fill = fill(bg)
      cell.alignment = { horizontal: align, vertical: 'middle' }
      if (nf && typeof val === 'number') cell.numFmt = nf
      cell.border = { bottom: { style: 'hair', color: { argb: C.border } } }
    })
  })

  return ws
}

// ── Función principal ──────────────────────────────────────────────────────
export async function generateExcel(currency) {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'FacturaIA'
  wb.created = new Date()
  wb.modified = new Date()
  wb.properties.date1904 = false

  const invoices = getInvoices(currency)

  buildSheetFacturas(wb, invoices, currency)
  buildSheetEstadoResultados(wb, currency)
  buildSheetBalance(wb, currency)

  return wb
}
