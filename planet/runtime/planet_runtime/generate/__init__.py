"""Build-time generators for Planet's static data.

Each module turns part of Galaxy's server state (datatype registry, genome builds,
tool sources) into the JSON files the Planet service worker serves in place of the
corresponding Galaxy API endpoints. The modules use Galaxy's own code, from the
planet-runtime image or a checkout's ``lib``, and avoid ``galaxy.tools``, which
needs the ORM.
"""

from planet_runtime import galaxy_env

galaxy_env.install_managers()
