#!/bin/bash

git diff --name-status "$PR_BASE" "$PR_HEAD"

# Abort if anything but modified and added
abort=$(git diff --name-status "$PR_BASE" "$PR_HEAD" | cut -c1 | grep -E "C|D|R|T|U|X|B" )

echo "Starting"

if [[ ! -n $abort ]]; then

    curl -O https://gist.githubusercontent.com/almahmoud/a67fb678b76c901e19385f85d02ef8ca/raw/2388c72efe6aa0c0757d76e9b6828f05b6f4b410/values.yaml

    helm repo add gxy https://raw.githubusercontent.com/cloudve/helm-charts/master/

    echo "Starting making list"
    git diff --name-only "$PR_BASE" "$PR_HEAD" > filelist

    while IFS= read -r line; do echo -n $line | base64; done < filelist | tr A-Z a-z | sed -E s/[^a-z0-9]+/-/g | sed -E s/^-+\|-+$//g  | cut -c -30 > encfilelist
    sed -E 's#.+#--set-file configs."#g' filelist > start
    sed -E 's#.+#=#g' filelist > middle
    paste -d "\0\"" start encfilelist middle filelist > setfilelist
    PROJMAN_SET=$(paste -s -d ' ' setfilelist)

    echo helm upgrade --install "galaxy-preview-injection-$PR_NUM" gxy/projman --set projectName="galaxy-$PR_NUM" $PROJMAN_SET
    helm upgrade --install galaxy-preview-injection-$PR_NUM gxy/projman --set projectName="galaxy-$PR_NUM" $PROJMAN_SET

    cat <<EOF > vols.yaml
extraVolumes:
EOF

    cat <<EOF > vol-mounts.yaml
extraVolumeMounts:
EOF

    while read line; do
      echo "Injecting $line"
      sed -E "s#--set-file configs.\"([^\"]+)\"=(([^/]+/)+)([^/\n]+)#  - name: \"code-injection-\1\"\n    configMap:\n      name: galaxy-$PR_NUM-projman-configs\n      items:\n        - key: \"\1\"\n          path: \"\4\"#g" <<< $line >> vols.yaml
      sed -E "s#--set-file configs.\"([^\"]+)\"=(([^/]+/)+)([^/\n]+)#  - name: \"code-injection-\1\"\n    mountPath: \"/galaxy/server/\2\4\"#g" <<< $line >> vol-mounts.yaml

    done <setfilelist

    echo helm upgrade --install "galaxy-preview-$PR_NUM" gxy/galaxy -f values.yaml -f vols.yaml -f vol-mounts.yaml
    helm upgrade --install "galaxy-preview-$PR_NUM" gxy/galaxy -f values.yaml -f vols.yaml -f vol-mounts.yaml > gxyinstalloutput

fi

