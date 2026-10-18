// Run via marionette.mjs. A "none" server can't be the default account, so
// compose-tests.js passes this identity explicitly.
const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
const EMAIL = "tester@example.org";
let account = MailServices.accounts.accounts.find(a => a.defaultIdentity?.email === EMAIL);
if (!account) {
  let local = null;
  try {
    local = MailServices.accounts.localFoldersServer;
  } catch (e) {}
  if (!local) {
    MailServices.accounts.createLocalMailAccount();
  }
  const server = MailServices.accounts.createIncomingServer("tester", "ribbon.test", "none");
  server.prettyName = "Ribbon Test";
  const identity = MailServices.accounts.createIdentity();
  identity.email = EMAIL;
  identity.fullName = "Ribbon Tester";
  identity.composeHtml = true;
  account = MailServices.accounts.createAccount();
  account.incomingServer = server;
  account.addIdentity(identity);
  MailServices.accounts.saveAccountInfo?.();
}
return { account: account.key, identity: account.defaultIdentity.email };
