#!/bin/bash

set -e

helm repo add gxy https://raw.githubusercontent.com/cloudve/helm-charts/master/

echo $PR_NUMBER

echo $PR_HEAD
echo $PR_BASE


echo $PR_NUMBER2

git diff --name-only $PR_HEAD $PR_BASE > filelist

cat filelist
