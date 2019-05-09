#!/usr/bin/env python

"""
Uses pysam to read a bgzip'd vcf file's contents and write them to an uncompressed vcf file.

usage: %prog in_file out_file
"""
import optparse

import pysam


def main():
    parser = optparse.OptionParser()
    (options, args) = parser.parse_args()
    input_fname, output_fname = args

    bgzipped = pysam.BGZFile(input_fname)
    with open(output_fname, 'w') as vcf_output:
        for content in bgzipped:
            vcf_output.write(content + "\n")


if __name__ == "__main__":
    main()
