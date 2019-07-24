"""

"""

import json
import os
import random
import string

from base import integration_util  # noqa: I202
from base.populators import (
    DatasetPopulator,
)

from test_jobs import _get_datasets_files_in_path

TEST_INPUT_FILES_CONTENT = "abc def 123 456"

EXPECTED_FILES_COUNT_IN_OUTPUT = 11

ADMIN_USER_EMAIL = "vahid@test.com"


class BaseUserBasedObjectStoreTestCase(integration_util.IntegrationTestCase):
    framework_tool_and_types = True

    @classmethod
    def handle_galaxy_config_kwds(cls, config):
        template = string.Template("""<?xml version="1.0"?>
        <object_store type="hierarchical">
            <backends>
                <backend id="default" type="disk" order="1">
                    <files_dir path="${temp_directory}/files_default"/>
                    <extra_dir type="temp" path="${temp_directory}/tmp_default"/>
                    <extra_dir type="job_work" path="${temp_directory}/job_working_directory_default"/>
                </backend>
            </backends>
        </object_store>
        """)

        temp_directory = cls._test_driver.mkdtemp()
        cls.object_stores_parent = temp_directory
        disk_store_path = os.path.join(temp_directory, "files_default")
        os.makedirs(disk_store_path)
        cls.files_default_path = disk_store_path
        config_path = os.path.join(temp_directory, "object_store_conf.xml")
        with open(config_path, "w") as f:
            f.write(template.safe_substitute({"temp_directory": temp_directory}))
        config["object_store_config_file"] = config_path
        config["enable_quotas"] = True
        config["admin_users"] = ADMIN_USER_EMAIL

    @classmethod
    def setup_objectstore(cls):
        pass

    def setUp(self):
        super(BaseUserBasedObjectStoreTestCase, self).setUp()

    @staticmethod
    def _rnd_str_generator(length=2, chars=string.ascii_uppercase + string.digits):
        return ''.join(random.choice(chars) for _ in range(length))

    def _create_content_of_size(self, size=1024):
        return self._rnd_str_generator(length=size)

    def run_tool(self, history_id, content=TEST_INPUT_FILES_CONTENT):
        hda = self.dataset_populator.new_dataset(history_id, content=content)
        self.dataset_populator.wait_for_history(history_id)
        hda_input = {"src": "hda", "id": hda["id"]}
        inputs = {
            "input1": hda_input,
            "input2": hda_input,
        }

        self.dataset_populator.run_tool(
            "create_10",
            inputs,
            history_id,
            assert_ok=True,
        )
        self.dataset_populator.wait_for_history(history_id)

    @staticmethod
    def assert_content(files, expected_content):
        for filename in files:
            with open(filename) as f:
                content = f.read().strip()
                assert content in expected_content
                expected_content.remove(content)
        # This confirms that no two (or more) files had same content.
        assert len(expected_content) == 0

    @staticmethod
    def get_files_count(directory):
        return sum(len(files) for _, _, files in os.walk(directory))

    def plug_user_media(self, category, path, order, quota="0.0", usage="0.0", authz_id=None):
        payload = {
            "category": category,
            "path": path,
            "authz_id": authz_id,
            "order": order,
            "quota": quota,
            "usage": usage
        }
        response = self._post(path="plugged_media/create", data=payload)
        return json.loads(response.content)


class DataPersistedOnUserMedia(BaseUserBasedObjectStoreTestCase):

    def setUp(self):
        super(DataPersistedOnUserMedia, self).setUp()
        self.dataset_populator = DatasetPopulator(self.galaxy_interactor)

    def test_files_count_and_content_in_user_media(self):
        """
        This test checks if tool execution results are correctly stored
        in user media, and deleted (purged) when asked. In general, this
        test does the following:

        1- plugs a media for the user;

        2- check if both instance-wide and user media are empty;

        3- runs a tool that creates 10 output, and checks:
          a- if all the output of the tool are stored in user media,
          b- if the content of the files matches the expected content;

        4- purges all the newly created datasets, and check if their
        files are deleted from the user media.
        """
        with self._different_user("vahid@test.com"):
            user_media_path = os.path.join(self._test_driver.mkdtemp(), "user/media/path/")
            plugged_media = self.plug_user_media("local", user_media_path, "1", quota="10240")

            # No file should be in the instance-wide storage before
            # execution of any tool.
            assert self.get_files_count(self.files_default_path) == 0

            # No file should be in user's plugged media before
            # execution of any tool.
            assert self.get_files_count(plugged_media.get("path")) == 0

            with self.dataset_populator.test_history() as history_id:
                self.run_tool(history_id)

                assert self.get_files_count(self.files_default_path) == 0
                assert self.get_files_count(plugged_media.get("path")) == EXPECTED_FILES_COUNT_IN_OUTPUT

                # Assert content
                files = _get_datasets_files_in_path(plugged_media.get("path"))
                expected_content = [str(x) for x in
                                    range(1, EXPECTED_FILES_COUNT_IN_OUTPUT)] + [TEST_INPUT_FILES_CONTENT]
                self.assert_content(files, expected_content)

                history_details = self._get(path="histories/" + history_id)
                datasets = json.loads(history_details.content)["state_ids"]["ok"]

                assert len(datasets) == EXPECTED_FILES_COUNT_IN_OUTPUT

                data = {"purge": True}
                for dataset_id in datasets:
                    self._delete("histories/{}/contents/{}".format(history_id, dataset_id), data=data)

                files = _get_datasets_files_in_path(plugged_media.get("path"))

                # After purging, all the files in the user media should be deleted.
                assert len(files) == 0

    def test_anonymous_user_should_be_able_to_store_data_without_having_to_plug_a_media(self):
        """
        This test asserts if an anonymous user is able to user Galaxy without
        having to plug a media. In general, it asserts if an anonymous user
        is able to upload a dataset, run a tool, and successfully delete/purge
        datasets without having to plug a media.
        """
        with self._different_user("vahid@test.com"):
            # No file should be in the instance-wide storage before
            # execution of any tool.
            assert self.get_files_count(self.files_default_path) == 0

            with self.dataset_populator.test_history() as history_id:
                self.run_tool(history_id)

                assert self.get_files_count(self.files_default_path) == EXPECTED_FILES_COUNT_IN_OUTPUT

                # Assert content
                files = _get_datasets_files_in_path(self.files_default_path)
                expected_content = [str(x) for x in
                                    range(1, EXPECTED_FILES_COUNT_IN_OUTPUT)] + [TEST_INPUT_FILES_CONTENT]
                self.assert_content(files, expected_content)

                history_details = self._get(path="histories/" + history_id)
                datasets = json.loads(history_details.content)["state_ids"]["ok"]

                assert len(datasets) == EXPECTED_FILES_COUNT_IN_OUTPUT

                data = {"purge": True}
                for dataset_id in datasets:
                    self._delete("histories/{}/contents/{}".format(history_id, dataset_id), data=data)

                files = _get_datasets_files_in_path(self.files_default_path)

                # After purging, all the files in the user media should be deleted.
                assert len(files) == 0

    def test_user_media_isolation(self):
        """
        Asserts if the media of different users are isolated from each other.

        More specifically, it asserts if the data of one user is not persisted
        in a media of another user, and when purging user data, only their data
        is purged and other users data is intact. For this, this test asserts the
        following:

        1- creates 10 users, plugs separate media for each, and asserts if
        the media is empty before running any job;

        2- for each user, runs a tool that creates 10 datasets, and waits for
        all the jobs to finish, then asserts if:
            a- there are 11 files (one input and ten tool execution output)
            in each user's media;
            b- the content of files, where 1/11 file per user has unique content, and
            10/11 files have common content.

        3- for each user, purges all their datasets, then asserts if:
            a- all the files in that user's media are deleted;
            b- for all other users, checks if the data in their media is intact.
        """
        users_count = 11
        users_data = {}
        for i in range(1, users_count):
            rnd_user_id = self._rnd_str_generator()
            users_data[i] = {
                "email": "vahid_{}@test.com".format(rnd_user_id),
                "path":  "user_{}/media/path/".format(rnd_user_id),
                "content": self._rnd_str_generator(10)
            }

            with self._different_user(users_data[i]["email"]):
                user_media_path = os.path.join(self._test_driver.mkdtemp(), users_data[i]["path"])
                plugged_media = self.plug_user_media("local", user_media_path, "1", quota="10240.0")
                users_data[i].update({"media": plugged_media})

                # No file should be in the instance-wide storage before
                # execution of any tool, this can also guarantee that user's
                # data is not persisted on the default storage as a result
                # of this iteration.
                assert self.get_files_count(self.files_default_path) == 0

                # No file should be in user's plugged media before
                # execution of any tool.
                assert self.get_files_count(plugged_media.get("path")) == 0

                with self.dataset_populator.test_history() as history_id:
                    users_data[i].update({"history_id": history_id})
                    self.run_tool(history_id, users_data[i]["content"])
                    users_data[i].update({
                        "history_details": self._get(path="histories/" + users_data[i]["history_id"])
                    })

        # Assert the content of files in each user's media.
        # One of the files per user has unique content (see the randomly generated
        # `content`, and all the other files have common content (see the `create_10` tool)).
        for i in range(1, users_count):
            assert self.get_files_count(self.files_default_path) == 0
            assert self.get_files_count(users_data[i]["media"].get("path")) == EXPECTED_FILES_COUNT_IN_OUTPUT

            # Assert content
            files = _get_datasets_files_in_path(users_data[i]["media"].get("path"))
            expected_content = [str(x) for x in range(1, EXPECTED_FILES_COUNT_IN_OUTPUT)] + [users_data[i]["content"]]
            self.assert_content(files, expected_content)

        # Delete all the datasets of a user, and check if (a) all the dataset are
        # deleted, and (b) only that user's data are deleted.
        for i in range(1, users_count):
            with self._different_user(users_data[i]["email"]):
                datasets = json.loads(users_data[i]["history_details"].content)["state_ids"]["ok"]

                assert len(datasets) == EXPECTED_FILES_COUNT_IN_OUTPUT

                data = {"purge": True}
                for dataset_id in datasets:
                    self._delete("histories/{}/contents/{}".format(users_data[i]["history_id"], dataset_id), data=data)

                files = _get_datasets_files_in_path(users_data[i]["media"].get("path"))

                # After purging, all the files in the user media should be deleted.
                assert len(files) == 0

            # Only the data of user[i] (and [0-i] users) data should be deleted by now.
            # The goal is to assert if delete method is isolated and does not operate on
            # other user's media.
            for j in range(i + 1, users_count):
                with self._different_user(users_data[j]["email"]):
                    datasets = json.loads(users_data[j]["history_details"].content)["state_ids"]["ok"]

                    assert len(datasets) == EXPECTED_FILES_COUNT_IN_OUTPUT
                    files = _get_datasets_files_in_path(users_data[j]["media"].get("path"))

                    # After purging, all the files in the user media should be deleted.
                    assert len(files) == EXPECTED_FILES_COUNT_IN_OUTPUT


class DataDistributionAcrossUserAndInstanceWideMedia(BaseUserBasedObjectStoreTestCase):

    def setUp(self):
        super(DataDistributionAcrossUserAndInstanceWideMedia, self).setUp()
        self.dataset_populator = DatasetPopulator(self.galaxy_interactor)

    def t__est_media_selection_based_on_dataset_size(self):
        """
        This test asserts if Galaxy can switch between user and
        the instance-wide storage based on the quota on user media
        and instance wide, and based on the dataset size.

        Accordingly, this test creates two media for user:
        media_1 that has higher priority than the instance-wide storage, and
        media_2 that has lower priority than the instance-wide storage,
        hence any new dataset shall be persisted on media_1 until
        it's defined quota is exhausted, then should persist any
        new dataset on the instance-wide storage until it reaches
        user's quota (if any defined), and then uses media_2.

        To make this assertion, the test creates a dataset, and
        checks if this dataset is persisted on media_1, that also
        consumes all the quota on media_1. The important point at
        this point is that the dataset size should be accounted
        against media_1 quota, and NOT consume user's instance-wide
        quota. Then the test creates a second dataset, and asserts
        if it is persisted on the instance-wide storage, which
        consumes all the storage available on the instance-wide
        storage. Similarly, an important point here is that dataset
        size should be accounted against default storage and not
        any of their media. Then the test creates a third dataset,
        and asserts if it is persisted on the media_2.
        """
        with self._different_user(ADMIN_USER_EMAIL):
            self._post(
                path="quotas",
                data={
                    "name": "test",
                    "description": "testdesc",
                    "operation": "=",
                    "default": "registered",
                    "amount": "1KB"
                }
            )

            media_1 = self.plug_user_media(
                category="local",
                path=os.path.join(self._test_driver.mkdtemp(), "user/media/path_1/"),
                order="1",
                quota="1000.0"
            )

            media_2 = self.plug_user_media(
                category="local",
                path=os.path.join(self._test_driver.mkdtemp(), "user/media/path_2/"),
                order="-1",
                quota="102400"
            )

            # No file should be in the instance-wide storage before
            # execution of any tool.
            assert self.get_files_count(self.files_default_path) == 0

            # No file should be in user's plugged media before
            # execution of any tool.
            assert self.get_files_count(media_1.get("path")) == 0
            assert self.get_files_count(media_2.get("path")) == 0

            with self.dataset_populator.test_history() as history_id:
                hda1 = self.dataset_populator.new_dataset(history_id, content=self._create_content_of_size())
                self.dataset_populator.wait_for_history(history_id)

                assert self.get_files_count(media_1.get("path")) == 1
                assert self.get_files_count(self.files_default_path) == 0
                assert self.get_files_count(media_2.get("path")) == 0

                hda2 = self.dataset_populator.new_dataset(history_id, content=self._create_content_of_size())
                self.dataset_populator.wait_for_history(history_id)

                assert self.get_files_count(media_1.get("path")) == 1
                assert self.get_files_count(self.files_default_path) == 1
                assert self.get_files_count(media_2.get("path")) == 0

                hda3 = self.dataset_populator.new_dataset(history_id, content=self._create_content_of_size())
                self.dataset_populator.wait_for_history(history_id)

                assert self.get_files_count(media_1.get("path")) == 1
                assert self.get_files_count(self.files_default_path) == 1
                assert self.get_files_count(media_2.get("path")) == 1

                hda_input = {"src": "hda", "id": hda1["id"]}
                inputs = {
                    "input1": hda_input,
                    "input2": hda_input,
                }

                self.dataset_populator.run_tool(
                    "create_10",
                    inputs,
                    history_id,
                    assert_ok=True,
                )
                self.dataset_populator.wait_for_history(history_id)

                assert self.get_files_count(media_1.get("path")) == 1
                assert self.get_files_count(self.files_default_path) == 1
                assert self.get_files_count(media_2.get("path")) == 11

                hda_input = {"src": "hda", "id": hda2["id"]}
                inputs = {
                    "input1": hda_input,
                    "input2": hda_input,
                }

                self.dataset_populator.run_tool(
                    "create_10",
                    inputs,
                    history_id,
                    assert_ok=True,
                )
                self.dataset_populator.wait_for_history(history_id)

                assert self.get_files_count(media_1.get("path")) == 1
                assert self.get_files_count(self.files_default_path) == 1
                assert self.get_files_count(media_2.get("path")) == 21

                hda_input = {"src": "hda", "id": hda3["id"]}
                inputs = {
                    "input1": hda_input,
                    "input2": hda_input,
                }

                self.dataset_populator.run_tool(
                    "create_10",
                    inputs,
                    history_id,
                    assert_ok=True,
                )
                self.dataset_populator.wait_for_history(history_id)

                assert self.get_files_count(media_1.get("path")) == 1
                assert self.get_files_count(self.files_default_path) == 1
                assert self.get_files_count(media_2.get("path")) == 31
