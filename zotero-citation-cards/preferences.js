// Zotero runs this before inserting the pane, in a scope of its own, so the pane is wired up
// when Zotero reports it showing, which also happens each time the pane is revisited
window.addEventListener('showing', (event) => {
  if (event.target.id !== 'citecard-pane') {
    return;
  }
  let status = document.getElementById('citecard-scholar-status');
  let button = document.getElementById('citecard-scholar-button');
  let signOut = document.getElementById('citecard-scholar-sign-out');
  let warning = document.getElementById('citecard-scholar-warning');
  let refresh = async () => {
    warning.hidden = !Zotero.CiteCard.scholarFormatChanged();
    status.value = 'Checking…';
    let account = await Zotero.CiteCard.scholarAccount();
    status.value = account ? 'Signed in as ' + account : 'Not signed in.';
    button.label = account ? 'Open Google Scholar' : 'Sign in to Google Scholar';
    signOut.hidden = !account;
  };
  if (!button.citecardWired) {
    button.citecardWired = true;
    button.addEventListener('command', () => {
      Zotero.CiteCard.openScholar().addEventListener('unload', refresh, { once: true });
    });
    signOut.addEventListener('command', () => {
      Zotero.CiteCard.signOutOfScholar();
      refresh();
    });
  }
  refresh();
}, true);
