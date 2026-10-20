# Limitations

How Planet differs from a Galaxy server today. Where Galaxy's client loads a missing feature on
startup, Planet answers with an empty list; other requests for it get a Galaxy error, which usually
names the feature.

## Galaxy features

- **One user.** There are no accounts, logins, groups, roles, quotas or sharing between users.
- **Not available:** workflows and invocations, pages, visualization plugins, data libraries,
  interactive tools, user-defined tools, importing or exporting history archives, notifications,
  webhooks, tours and object store selection.
- **Reference data.** Data tables have no entries, so options from data tables (built-in indexes)
  are empty. Genome builds can be assigned, but Planet has no chromosome lengths, sequences or
  indexes for them.
- **Datatype conversion.** There are no converter tools: datasets are not converted implicitly for
  a tool input, and the Convert action of the dataset attributes form is not available.
- **Uploads** accept local files, pasted text and URLs. Deferred datasets, server paths and FTP
  imports are not available.
- **Downloads.** A dataset with extra files cannot be downloaded as one archive; its files are
  downloadable one by one.
- **Rerun.** Rerunning a failed job with its dependent jobs resumed is not supported.

## Tools

- **Containers only.** A tool runs in its declared Docker container, or in the BioContainers image
  whose name and tag match its package requirements exactly. Tools without package requirements run
  in `planet-runtime`. There is no Conda resolution, and a requirement without a matching image fails
  the job.
- **Architecture.** BioContainers images are amd64 only. With the default node architecture
  setting, tool pods whose image is not `planet-runtime` run only on amd64 nodes.
- **Dynamic options.** Options that come from datasets, files, URLs or Python code are empty, with a
  warning on the form. Validators that need dataset metadata or data tables are not checked.
- **Installation** works from the main and test Tool Shed and from GitHub commits. Repository
  dependencies are not installed. Data managers, data sources, interactive tools, tools with
  `<code>` files or dynamic options, and templates that use `$__app__` are refused.
- **Resources.** Every job gets the CPU, memory, scratch space and walltime of the cluster settings,
  raised to the tool's literal `cores_min`, `ram_min` and `tmpdir_min` requirements. Expressions in
  resource requirements are ignored.

## Collections

- **Map-over** does not support running a tool that takes a collection over each dataset of a list
  (Galaxy's collection adapters), over an empty collection, or over a collection together with an
  unlinked batch of datasets. Sample sheet collections are not available.
- **Collection operations** run in the Service Worker: zip, unzip, flatten, filter failed, filter
  empty, keep success and sort. Galaxy's other collection operations, such as Apply rules and
  relabelling from a file, are refused.

## Size limits

| Limit | Value |
| --- | --- |
| Jobs one tool run creates | 1000 |
| Datasets one tool job discovers | 32; more fail the job with Galaxy's `max_discovered_files` message |
| Datasets one upload creates | 5000 |
| Single-object outputs | 4.99 GiB; larger outputs are multipart uploads completed when the job is collected |

## Browsers and devices

- **A Planet tab must be open.** Pods run without the browser, but a tab dispatches queued jobs,
  starts jobs that depend on others and collects results. Jobs that finish while no tab is open are
  collected from the bucket when Planet is opened again, within the bucket's lifecycle rules: job
  files are deleted after 60 days and incomplete multipart uploads aborted after 30
  ([storage setup](storage-setup.md)).
- **Background tabs.** Browsers throttle hidden tabs, so jobs advance more slowly when no Planet tab
  is visible. iOS and iPadOS suspend background tabs.
- **Uploads run in the page.** Closing the tab stops an upload; uploading the same file to the same
  history resumes it.
- **Browser storage.** IndexedDB holds the histories and records. Browsers may evict it, and Safari
  may delete it after 7 days without a visit. Without a backup passphrase, an evicted or cleared
  database cannot be recovered, although the dataset objects stay in the bucket.
- **One device at a time.** Each browser profile has its own database. Another device continues an
  instance by restoring a snapshot ([security](security.md#multiple-devices)).
- **Required browser features.** Planet needs Service Workers, which some private windows disable,
  and needs Web Locks and BroadcastChannel to run jobs.
- **Safari** blocks requests from HTTPS pages to `http://` loopback addresses: with Planet served
  over HTTPS, it needs a gateway and a bucket endpoint on HTTPS
  ([cluster setup](cluster-setup.md#https-safari-remote-access)). Chrome and Firefox reach a
  port-forwarded gateway after the local network access prompt.
