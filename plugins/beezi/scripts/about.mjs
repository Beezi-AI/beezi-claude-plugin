import { aboutPlugin, formatAbout } from '../lib/about.mjs';

// /beezi:about — installed version, newest published version, when this machine last updated the
// plugin, and how to update. Exits 0 even offline: "could not check" is an answer, not a failure.
aboutPlugin()
  .then((info) => process.stdout.write(formatAbout(info)))
  .catch(() => process.stdout.write(formatAbout(null)));
