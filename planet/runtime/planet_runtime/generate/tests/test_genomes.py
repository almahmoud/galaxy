import os

from galaxy.util import galaxy_directory

from planet_runtime.generate.genomes import (
    dbkeys,
    SAMPLE_BUILDS,
)


def test_genomes_from_sample_builds():
    keys = dbkeys(os.path.join(galaxy_directory(), SAMPLE_BUILDS))
    assert keys[0] == ["unspecified (?)", "?"]
    assert all(len(pair) == 2 for pair in keys)
    assert len({key for _, key in keys}) == len(keys)
    assert ["Human Dec. 2013 (GRCh38/hg38) (hg38)", "hg38"] in keys


def test_duplicate_keys_keep_first_position(tmp_path):
    builds = tmp_path / "builds.txt"
    builds.write_text("#comment\nhg19\tFirst (hg19)\nmm10\tMouse (mm10)\nhg19\tSecond (hg19)\n")
    keys = dbkeys(str(builds))
    assert [key for _, key in keys] == ["?", "hg19", "mm10"]
