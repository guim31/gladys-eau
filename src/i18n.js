// -----------------------------------------------------------------------------
// Every text the container produces, in the four languages of the Gladys
// interface: English, French, German (informal "du") and Spanish (formal
// "usted"). Gladys does not tell a device integration its user's language:
// the `language` field of the configuration picks it (French by default).
// The vocabulary follows the Gladys interface (front/src/config/i18n): a
// "compteur", the "Découverte" tab, "Intégrations". Brand names (Suez, Saur,
// Tout sur mon eau) are never translated.
// -----------------------------------------------------------------------------

export const LANGUAGES = ['en', 'fr', 'de', 'es'];

/** A table entry in a language, English when the language is unknown. */
export function pick(table, language) {
  return table[language] ?? table.en;
}

/** Feature names, fixed when the user adds the device. */
export const FEATURE_NAMES = {
  en: {
    index: 'Meter index',
    daily_consumption: 'Daily consumption',
    month_consumption: 'Consumption this month',
    year_consumption: 'Consumption this year',
    price: 'Average water price (€/m³)',
    leak_alert: 'Leak alert (Suez)',
  },
  fr: {
    index: 'Index du compteur',
    daily_consumption: 'Consommation journalière',
    month_consumption: 'Consommation du mois',
    year_consumption: 'Consommation de l’année',
    price: 'Prix moyen de l’eau (€/m³)',
    leak_alert: 'Alerte fuite (Suez)',
  },
  de: {
    index: 'Zählerstand',
    daily_consumption: 'Tagesverbrauch',
    month_consumption: 'Verbrauch diesen Monat',
    year_consumption: 'Verbrauch dieses Jahr',
    price: 'Mittlerer Wasserpreis (€/m³)',
    leak_alert: 'Leckalarm (Suez)',
  },
  es: {
    index: 'Índice del contador',
    daily_consumption: 'Consumo diario',
    month_consumption: 'Consumo del mes',
    year_consumption: 'Consumo del año',
    price: 'Precio medio del agua (€/m³)',
    leak_alert: 'Alerta de fuga (Suez)',
  },
};

/** The device name, followed by the distributor and the meter number. */
export const DEVICE_NAMES = {
  en: 'Water meter',
  fr: 'Compteur d’eau',
  de: 'Wasserzähler',
  es: 'Contador de agua',
};

/**
 * Status and action messages: multi-language objects, or functions that
 * build one. Shown in the Configuration screen (200 characters at most).
 */
export const MESSAGES = {
  notConfigured: {
    en: 'Choose your water distributor and enter the email and password of your online customer area.',
    fr: 'Choisissez votre distributeur d’eau et saisissez l’adresse e-mail et le mot de passe de votre espace client.',
    de: 'Wähle deinen Wasserversorger und gib E-Mail-Adresse und Passwort deines Kundenkontos ein.',
    es: 'Elija su distribuidor de agua e introduzca el correo y la contraseña de su área de cliente.',
  },
  unsupportedProvider: {
    en: 'This distributor is not supported. Choose Suez or Saur.',
    fr: 'Ce distributeur n’est pas pris en charge. Choisissez Suez ou Saur.',
    de: 'Dieser Versorger wird nicht unterstützt. Wähle Suez oder Saur.',
    es: 'Este distribuidor no es compatible. Elija Suez o Saur.',
  },
  invalidAuth: (provider) => ({
    en: `${provider} refused the email or the password: check them, then save the configuration.`,
    fr: `${provider} refuse l’adresse e-mail ou le mot de passe : vérifiez-les, puis enregistrez la configuration.`,
    de: `${provider} lehnt E-Mail-Adresse oder Passwort ab: prüfe sie und speichere dann die Konfiguration.`,
    es: `${provider} rechaza el correo o la contraseña: compruébelos y guarde la configuración.`,
  }),
  cannotConnect: (provider, reason) => ({
    en: `${provider} cannot be reached for now (${reason}). Next try within the hour.`,
    fr: `${provider} est injoignable pour l’instant (${reason}). Nouvel essai dans l’heure.`,
    de: `${provider} ist gerade nicht erreichbar (${reason}). Neuer Versuch innerhalb einer Stunde.`,
    es: `${provider} no responde por ahora (${reason}). Nuevo intento dentro de una hora.`,
  }),
  noMeter: (provider) => ({
    en: `${provider} lists no water meter on this account.`,
    fr: `${provider} ne liste aucun compteur d’eau sur ce compte.`,
    de: `${provider} listet keinen Wasserzähler in diesem Konto.`,
    es: `${provider} no muestra ningún contador de agua en esta cuenta.`,
  }),
  meterNotFound: (numbers) => ({
    en: `No meter matches the configured number. Meters of the account: ${numbers}.`,
    fr: `Aucun compteur ne correspond au numéro configuré. Compteurs du compte : ${numbers}.`,
    de: `Kein Zähler passt zur eingestellten Nummer. Zähler des Kontos: ${numbers}.`,
    es: `Ningún contador coincide con el número configurado. Contadores de la cuenta: ${numbers}.`,
  }),
  signedIn: (provider, count) => ({
    en: `Connected to ${provider}: ${count} meter(s) found. Add them from the Discovery tab.`,
    fr: `Connecté à ${provider} : ${count} compteur(s) trouvé(s). Ajoutez-les depuis l’onglet Découverte.`,
    de: `Mit ${provider} verbunden: ${count} Zähler gefunden. Füge sie im Tab Entdecken hinzu.`,
    es: `Conectado a ${provider}: ${count} contador(es) encontrado(s). Añádalos desde la pestaña Descubrir.`,
  }),
  refreshed: (provider, date) => ({
    en: `Readings refreshed from ${provider}: data up to ${date}.`,
    fr: `Relevés mis à jour depuis ${provider} : données jusqu’au ${date}.`,
    de: `Ablesungen von ${provider} aktualisiert: Daten bis ${date}.`,
    es: `Lecturas actualizadas desde ${provider}: datos hasta el ${date}.`,
  }),
  stillRunning: {
    en: 'The first import of the history is running: it goes on in the background.',
    fr: 'Le premier import de l’historique est en cours : il se poursuit en arrière-plan.',
    de: 'Der erste Import des Verlaufs läuft: er geht im Hintergrund weiter.',
    es: 'La primera importación del historial está en curso: continúa en segundo plano.',
  },
  refreshTooSoon: (minutes) => ({
    en: `Readings were refreshed a moment ago: try again in ${minutes} min.`,
    fr: `Les relevés viennent d’être mis à jour : réessayez dans ${minutes} min.`,
    de: `Die Ablesungen wurden gerade aktualisiert: versuche es in ${minutes} Min. erneut.`,
    es: `Las lecturas se acaban de actualizar: inténtelo de nuevo en ${minutes} min.`,
  }),
  initFailed: {
    en: 'Initialization failed, check the integration logs.',
    fr: 'L’initialisation a échoué, consultez les journaux de l’intégration.',
    de: 'Die Initialisierung ist fehlgeschlagen, sieh dir die Logs der Integration an.',
    es: 'La inicialización ha fallado, consulte los registros de la integración.',
  },
};

/** The reasons of an "abnormal consumption" event, for the widget and the docs. */
export const REASONS = {
  en: {
    leak_alert: 'Leak alert from the distributor',
    overconsumption_alert: 'Overconsumption alert (distributor)',
    unusual_consumption: 'Several days far above usual',
  },
  fr: {
    leak_alert: 'Alerte fuite du distributeur',
    overconsumption_alert: 'Alerte surconsommation du distributeur',
    unusual_consumption: 'Jours bien au-dessus de l’habitude',
  },
  de: {
    leak_alert: 'Leckalarm des Versorgers',
    overconsumption_alert: 'Mehrverbrauchsalarm des Versorgers',
    unusual_consumption: 'Mehrere Tage weit über dem Üblichen',
  },
  es: {
    leak_alert: 'Alerta de fuga del distribuidor',
    overconsumption_alert: 'Alerta de sobreconsumo del distribuidor',
    unusual_consumption: 'Días muy por encima de lo habitual',
  },
};

const LOCALES = { en: 'en-GB', fr: 'fr-FR', de: 'de-DE', es: 'es-ES' };

/** "12 Oct" / "12 oct." for a YYYY-MM-DD date. */
export function formatDay(date, language) {
  const [y, m, d] = date.split('-').map(Number);
  return new Intl.DateTimeFormat(LOCALES[language] ?? LOCALES.en, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** A number with the decimal separator of the language. */
export function formatNumber(value, language, digits = 0) {
  return new Intl.NumberFormat(LOCALES[language] ?? LOCALES.en, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}
