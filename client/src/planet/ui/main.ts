/** Entry of /static/welcome.html: the Planet welcome and setup page, shown in Galaxy's center panel. */

import "@/compat-config";

import { createApp } from "vue";

import { BACKUP_SERVICES, browserBackupServices } from "./lib/backup";
import { browserServices, SERVICES } from "./lib/services";
import { browserToolServices, TOOL_SERVICES } from "./lib/tools";

import App from "./App.vue";

createApp(App)
    .provide(SERVICES, browserServices())
    .provide(BACKUP_SERVICES, browserBackupServices())
    .provide(TOOL_SERVICES, browserToolServices())
    .mount("#app");
