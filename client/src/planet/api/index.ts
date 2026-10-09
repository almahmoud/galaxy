import type { Router } from "@/planet/sw/router";

import { register as registerCollections } from "./collections";
import { register as registerConfiguration } from "./configuration";
import { register as registerContents } from "./contents";
import { register as registerContext } from "./context";
import { register as registerDatasets } from "./datasets";
import { register as registerDatatypes } from "./datatypes";
import { register as registerGenomes } from "./genomes";
import { register as registerHistories } from "./histories";
import { register as registerJobs } from "./jobs";
import { register as registerLegacyHistory } from "./legacyHistory";
import { register as registerPlanet } from "./planet";
import { register as registerStubs } from "./stubs";
import { register as registerTools } from "./tools";
import { register as registerUsers } from "./users";

/** Registers every API handler module on `router`. Registration order breaks ties between equally specific routes. */
export function registerAll(router: Router): void {
    registerContext(router);
    registerConfiguration(router);
    registerUsers(router);
    registerHistories(router);
    registerLegacyHistory(router);
    registerContents(router);
    registerDatasets(router);
    registerCollections(router);
    registerDatatypes(router);
    registerGenomes(router);
    registerTools(router);
    registerJobs(router);
    registerStubs(router);
    registerPlanet(router);
}
