"""Build-time generators for Planet's static data.

Each module turns part of Galaxy's server state (datatype registry, genome builds,
tool sources) into the JSON files the Planet service worker serves in place of the
corresponding Galaxy API endpoints. The modules use Galaxy's own code from the
checkout they run against and avoid ``galaxy.tools``, which needs the ORM.
"""
