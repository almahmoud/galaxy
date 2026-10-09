/** Entry of /static/welcome.html: the Planet welcome and setup page, shown in Galaxy's center panel. */

import "@/compat-config";

import { createApp } from "vue";

import { browserServices, SERVICES } from "./lib/services";

import App from "./App.vue";

createApp(App).provide(SERVICES, browserServices()).mount("#app");
