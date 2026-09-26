// Dinámicas de promociones del plan Premium.
// Cada negocio las prende o apaga en la pestaña "Crecer". Cuando alguna aplica, el sello vale doble
// (nunca más que doble, aunque apliquen varias a la vez).

const DAY_NAMES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

const DEFAULT_PROMOS = {
  welcome: { on: false },                                   // sello de bienvenida al aprobar la tarjeta
  days: { on: false, days: [2] },                           // días dobles (0 = domingo … 6 = sábado)
  happyHour: { on: false, from: '15:00', to: '18:00' },     // hora feliz: sello doble en ese horario
  birthday: { on: false },                                  // sello doble en la semana de su cumpleaños
  comeback: { on: false, days: 30 },                        // bono de regreso: si vuelve tras N días sin venir
  referral: { on: false },                                  // invita a un amigo: gana 1 sello cuando el amigo compra
  season: { on: false, from: '', to: '', name: 'Temporada doble' } // fechas especiales con sello doble
};

const REASON_LABELS = {
  bienvenida: 'Sello de bienvenida',
  doble: 'Sello doble',
  referido: 'Por invitar a un amigo',
  regalo: 'Regalo del negocio'
};

function parsePromos(raw) {
  let v = {};
  try { v = JSON.parse(raw || '{}') || {}; } catch (e) { v = {}; }
  return cleanPromos(v);
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

// Deja solo valores válidos (lo que venga de la pantalla nunca se guarda tal cual).
function cleanPromos(v) {
  v = v && typeof v === 'object' ? v : {};
  const on = x => Boolean(x && x.on === true);
  const days = Array.isArray(v.days?.days) ? [...new Set(v.days.days.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6))].sort() : DEFAULT_PROMOS.days.days;
  const from = HHMM.test(v.happyHour?.from) ? v.happyHour.from : DEFAULT_PROMOS.happyHour.from;
  const to = HHMM.test(v.happyHour?.to) ? v.happyHour.to : DEFAULT_PROMOS.happyHour.to;
  const cbDays = [15, 30, 45, 60, 90].includes(Number(v.comeback?.days)) ? Number(v.comeback.days) : 30;
  const sFrom = YMD.test(v.season?.from) ? v.season.from : '';
  const sTo = YMD.test(v.season?.to) ? v.season.to : '';
  return {
    welcome: { on: on(v.welcome) },
    days: { on: on(v.days) && days.length > 0, days },
    happyHour: { on: on(v.happyHour) && from < to, from, to },
    birthday: { on: on(v.birthday) },
    comeback: { on: on(v.comeback), days: cbDays },
    referral: { on: on(v.referral) },
    season: { on: on(v.season) && !!sFrom && !!sTo && sFrom <= sTo, from: sFrom, to: sTo, name: String(v.season?.name || 'Temporada doble').trim().slice(0, 30) || 'Temporada doble' }
  };
}

// Fecha y hora actuales en la Ciudad de México
function nowMx(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short'
  }).formatToParts(date).map(p => [p.type, p.value]));
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return { ymd: `${parts.year}-${parts.month}-${parts.day}`, weekday: wd, hhmm: `${hour}:${parts.minute}` };
}

function ymdToUtc(ymd) { return Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10)); }

// Días que faltan para su próximo cumpleaños (0 = hoy) y días desde el último.
function birthdayDistance(mmdd, todayYmd) {
  if (!mmdd) return null;
  const y = +todayYmd.slice(0, 4);
  const t = ymdToUtc(todayYmd);
  const at = yy => {
    let m = +mmdd.slice(0, 2), d = +mmdd.slice(3, 5);
    if (m === 2 && d === 29 && !(yy % 4 === 0 && (yy % 100 !== 0 || yy % 400 === 0))) d = 28;
    return Date.UTC(yy, m - 1, d);
  };
  let next = at(y); if (next < t) next = at(y + 1);
  let prev = at(y); if (prev > t) prev = at(y - 1);
  return { until: Math.round((next - t) / 86400000), since: Math.round((t - prev) / 86400000) };
}

function inBirthdayWeek(mmdd, todayYmd) {
  const d = birthdayDistance(mmdd, todayYmd);
  return !!d && (d.until <= 3 || d.since <= 3);
}

// Promociones "para todos" activas en este momento (días, hora feliz, temporada)
function globalDoubles(promos, now = nowMx()) {
  const out = [];
  if (promos.days.on && promos.days.days.includes(now.weekday)) out.push(`${cap(DAY_NAMES[now.weekday])} doble`);
  if (promos.happyHour.on && now.hhmm >= promos.happyHour.from && now.hhmm < promos.happyHour.to) out.push('Hora feliz');
  if (promos.season.on && now.ymd >= promos.season.from && now.ymd <= promos.season.to) out.push(promos.season.name);
  return out;
}

// Promociones personales: su semana de cumpleaños, o que regresa después de mucho tiempo.
function personalDoubles(promos, customer, lastVisitIso, now = nowMx()) {
  const out = [];
  if (promos.birthday.on && customer.birthday && inBirthdayWeek(customer.birthday, now.ymd)) out.push('Semana de cumpleaños');
  if (promos.comeback.on && lastVisitIso) {
    const days = (Date.now() - new Date(lastVisitIso).getTime()) / 86400000;
    if (days >= promos.comeback.days) out.push('Bono de regreso');
  }
  return out;
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

const DAY_PLURAL = ['domingos', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábados'];
function daysText(days) {
  const names = days.map(d => DAY_PLURAL[d]);
  if (names.length === 1) return `los ${names[0]}`;
  return 'los ' + names.slice(0, -1).join(', ') + ' y ' + names[names.length - 1];
}

// Resumen para mostrar a los clientes (tarjeta y registro)
function publicPromos(promos, now = nowMx()) {
  const rules = [];
  if (promos.days.on) rules.push(`Sello doble ${daysText(promos.days.days)}`);
  if (promos.happyHour.on) rules.push(`Hora feliz: sello doble de ${promos.happyHour.from} a ${promos.happyHour.to}`);
  if (promos.season.on && now.ymd <= promos.season.to) rules.push(`${promos.season.name}: sello doble del ${fmtYmd(promos.season.from)} al ${fmtYmd(promos.season.to)}`);
  if (promos.birthday.on) rules.push('Sello doble en la semana de tu cumpleaños');
  if (promos.comeback.on) rules.push(`Si regresas después de ${promos.comeback.days} días, tu sello vale doble`);
  if (promos.referral.on) rules.push('Invita a un amigo: cuando haga su primera compra, ganas 1 sello');
  return { welcome: promos.welcome.on, referral: promos.referral.on, doubleNow: globalDoubles(promos, now), rules };
}

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
function fmtYmd(ymd) { return ymd ? `${+ymd.slice(8, 10)} ${MESES[+ymd.slice(5, 7) - 1]}` : ''; }

module.exports = {
  DEFAULT_PROMOS, REASON_LABELS, parsePromos, cleanPromos, nowMx, birthdayDistance, inBirthdayWeek,
  globalDoubles, personalDoubles, publicPromos
};
