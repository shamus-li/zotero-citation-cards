var CiteCard, CiteCardLookup;

// Shared with citecard.js, and needed by uninstall() after it has been unloaded
var OPENALEX_KEY_PREF = 'extensions.citecard.openalexKey';
// Google sign-in cookies live in their own cookie jar, which only the Scholar sign-in
// window and the plugin's Scholar requests use
var SCHOLAR_CONTEXT_ID = 47110;

function install() {}

// Reason 6 is ADDON_UNINSTALL; upgrades and downgrades also call uninstall() and keep
// the sign-in and settings
function uninstall(data, reason) {
  if (reason !== 6) {
    return;
  }
  Services.cookies.removeCookiesWithOriginAttributes(JSON.stringify({ userContextId: SCHOLAR_CONTEXT_ID }));
  Services.prefs.clearUserPref(OPENALEX_KEY_PREF);
}

async function startup({ id, version, rootURI }) {
  await Zotero.initializationPromise;
  Services.scriptloader.loadSubScript(rootURI + 'lookup.js');
  Services.scriptloader.loadSubScript(rootURI + 'citecard.js');
  await CiteCard.init({ id, version, rootURI });
}

function shutdown() {
  CiteCard?.shutdown();
  CiteCard = undefined;
  CiteCardLookup = undefined;
}
