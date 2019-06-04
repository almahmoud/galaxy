#!/usr/bin/env python

"""
Uses pysam to read a bgzip'd vcf file's contents and write them to an uncompressed vcf file.

usage: %prog in_file out_file
"""
import argparse

import pysam


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('input')
    parser.add_argument('output')
    args = parser.parse_args()
    input_fname = args.input
    output_fname = args.output

    bgzipped = pysam.BGZFile(input_fname)
    with open(output_fname, 'w') as vcf_output:
        for content in bgzipped:
            vcf_output.write(str(content) + "\n")


if __name__ == "__main__":
    main()
