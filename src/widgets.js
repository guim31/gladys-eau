// -----------------------------------------------------------------------------
// The dashboard widget "Water consumption": the last known day, the month so
// far and how it compares with the same days of the previous month and of
// last year, with the last 14 days as bars.
//
// Built from what the last cycle read (no sign-in per display), localized
// from the widget's language. Core budget: 8 components, 6 tiles, 2 texts,
// 1 status list, 1 focal (the chart). The values are plain tiles (not bound
// to a feature): the widget works before the meter is added to Gladys, and
// the integration asks for a refresh after every cycle.
// -----------------------------------------------------------------------------

import {
  WIDGET_CHART_TYPES,
  WIDGET_COLORS,
  WIDGET_TEXT_VARIANTS,
} from '@gladysassistant/integration-sdk';
import { formatDay, formatNumber, REASONS } from './i18n.js';
import { addDays, readingInstant } from './time.js';

// The data moves three times a day: an hour of cache is plenty.
const TTL_SECONDS = 3600;
// A month more than this above its references shows in the warning colour.
const WARNING_CHANGE = 20;

export const WIDGET_TEXT = {
  en: {
    yesterday: 'Yesterday',
    lastDay: 'Last day',
    month: 'This month',
    vsPreviousMonth: 'vs last month',
    vsLastYear: 'vs last year',
    year: 'This year',
    price: 'Average price',
    alert: 'Alert',
    chart: 'Last 14 days (L)',
    dataUntil: (date) => `Data up to ${date} (published a day or two late)`,
    notConfigured: 'Configure the integration: distributor, email and password.',
    password: 'The distributor refused the sign-in: check the integration configuration.',
    noData: 'No reading yet: the first ones come after the sign-in.',
  },
  fr: {
    yesterday: 'Hier',
    lastDay: 'Dernier jour',
    month: 'Ce mois-ci',
    vsPreviousMonth: 'vs mois dernier',
    vsLastYear: 'vs l’an dernier',
    year: 'Cette année',
    price: 'Prix moyen',
    alert: 'Alerte',
    chart: '14 derniers jours (L)',
    dataUntil: (date) => `Données jusqu’au ${date} (publiées avec un ou deux jours de retard)`,
    notConfigured: 'Configurez l’intégration : distributeur, adresse e-mail et mot de passe.',
    password: 'Le distributeur refuse la connexion : vérifiez la configuration de l’intégration.',
    noData: 'Aucun relevé pour l’instant : les premiers arrivent après la connexion.',
  },
  de: {
    yesterday: 'Gestern',
    lastDay: 'Letzter Tag',
    month: 'Dieser Monat',
    vsPreviousMonth: 'ggü. Vormonat',
    vsLastYear: 'ggü. Vorjahr',
    year: 'Dieses Jahr',
    price: 'Mittlerer Preis',
    alert: 'Alarm',
    chart: 'Letzte 14 Tage (L)',
    dataUntil: (date) => `Daten bis ${date} (ein bis zwei Tage verzögert)`,
    notConfigured: 'Richte die Integration ein: Versorger, E-Mail-Adresse und Passwort.',
    password: 'Der Versorger lehnt die Anmeldung ab: prüfe die Konfiguration der Integration.',
    noData: 'Noch keine Ablesung: die ersten kommen nach der Anmeldung.',
  },
  es: {
    yesterday: 'Ayer',
    lastDay: 'Último día',
    month: 'Este mes',
    vsPreviousMonth: 'vs mes pasado',
    vsLastYear: 'vs año pasado',
    year: 'Este año',
    price: 'Precio medio',
    alert: 'Alerta',
    chart: 'Últimos 14 días (L)',
    dataUntil: (date) => `Datos hasta el ${date} (con uno o dos días de retraso)`,
    notConfigured: 'Configure la integración: distribuidor, correo y contraseña.',
    password: 'El distribuidor rechaza la conexión: compruebe la configuración de la integración.',
    noData: 'Aún no hay lecturas: las primeras llegan tras la conexión.',
  },
};

function message(text) {
  return {
    ttl_seconds: 300,
    components: [{ type: 'text', variant: WIDGET_TEXT_VARIANTS.BODY, text }],
  };
}

/** "+12 %" / "-8 %", within the 12 characters of a tile. */
function signedPercent(value, language) {
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${formatNumber(Math.abs(value), language)} %`;
}

function changeColor(value) {
  if (value >= WARNING_CHANGE) {
    return WIDGET_COLORS.WARNING;
  }
  return value <= 0 ? WIDGET_COLORS.SUCCESS : WIDGET_COLORS.NEUTRAL;
}

/**
 * @param {object} input
 * @param {object|null} input.meter a meter of the last cycle (src/app.js)
 * @param {string} input.language
 * @param {boolean} input.configured
 * @param {boolean} input.passwordRefused
 * @param {string} input.today the Paris date
 */
export function buildWidgetContent({ meter, language, configured, passwordRefused, today }) {
  const t = WIDGET_TEXT[language] ?? WIDGET_TEXT.en;
  if (!configured) {
    return message(t.notConfigured);
  }
  if (passwordRefused) {
    return message(t.password);
  }
  const summary = meter?.summary;
  if (!summary?.lastDay) {
    return message(t.noData);
  }
  const { lastDay, comparison } = summary;
  const isYesterday = lastDay.date === addDays(today, -1);
  const components = [
    {
      type: 'text',
      variant: WIDGET_TEXT_VARIANTS.CAPTION,
      text: t.dataUntil(formatDay(lastDay.date, language)),
    },
    {
      type: 'value',
      label: isYesterday ? t.yesterday : `${t.lastDay} ${formatDay(lastDay.date, language)}`,
      value: lastDay.liters,
      unit: 'L',
      icon: 'droplet',
      color: WIDGET_COLORS.PRIMARY,
    },
    {
      type: 'value',
      label: t.month,
      value: summary.monthM3,
      unit: 'm³',
      icon: 'calendar',
    },
  ];
  if (comparison?.previousMonthChange !== null && comparison?.previousMonthChange !== undefined) {
    components.push({
      type: 'value',
      label: t.vsPreviousMonth,
      value: signedPercent(comparison.previousMonthChange, language),
      icon: 'trending-up',
      color: changeColor(comparison.previousMonthChange),
    });
  }
  if (comparison?.lastYearChange !== null && comparison?.lastYearChange !== undefined) {
    components.push({
      type: 'value',
      label: t.vsLastYear,
      value: signedPercent(comparison.lastYearChange, language),
      icon: 'bar-chart-2',
      color: changeColor(comparison.lastYearChange),
    });
  }
  if (summary.recent.length >= 2) {
    components.push({
      type: 'chart',
      chart_type: WIDGET_CHART_TYPES.BAR,
      title: t.chart,
      unit: 'L',
      series: [
        {
          name: 'L',
          points: summary.recent.map((day) => ({ t: readingInstant(day.date), v: day.liters })),
        },
      ],
    });
  }
  const items = [
    { label: t.year, value: `${formatNumber(summary.yearM3, language, 1)} m³`, icon: 'calendar' },
  ];
  if (typeof meter.extras?.priceEurPerM3 === 'number') {
    items.push({
      label: t.price,
      value: `${formatNumber(meter.extras.priceEurPerM3, language, 2)} €/m³`,
      icon: 'tag',
    });
  }
  if (meter.episode) {
    items.push({
      label: t.alert,
      value: (REASONS[language] ?? REASONS.en)[meter.episode.reason] ?? meter.episode.reason,
      icon: 'alert-triangle',
      color: WIDGET_COLORS.DANGER,
    });
  }
  components.push({ type: 'status', items });
  return { ttl_seconds: TTL_SECONDS, components };
}
