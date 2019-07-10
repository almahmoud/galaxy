"""

"""

import json
import os
import string

from base import integration_util  # noqa: I202
from base.populators import (
    DatasetPopulator,
)

from test_jobs import _get_datasets_files_in_path

TEST_INPUT_FILES_CONTENT = "abc def 123 456"


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

    @classmethod
    def setup_objectstore(cls):
        pass

    def setUp(self):
        super(BaseUserBasedObjectStoreTestCase, self).setUp()

    def run_tool(self, history_id):
        hda1 = self.dataset_populator.new_dataset(history_id, content=TEST_INPUT_FILES_CONTENT)
        self.dataset_populator.wait_for_history(history_id)
        hda1_input = {"src": "hda", "id": hda1["id"]}
        inputs = {
            "input1": hda1_input,
            "input2": hda1_input,
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
        # This test check if tool execution results are correctly stored
        # in user media, and deleted (purged) when asked. In general, this
        # test does the following:
        # 1- plugs a media for the user;
        # 2- check if both instance-wide and user media are empty;
        # 3- runs a tool that creates 10 output, and checks:
        #   a- if all the output of the tool are stored in user media,
        #   b- if the content of the files matches the expected content;
        # 4- purges all the newly created datasets, and check if their
        # files are deleted from the user media.
        with self._different_user("vahid@test.com"):
            user_media_path = os.path.join(self._test_driver.mkdtemp(), "user/media/path/")
            plugged_media = self.plug_user_media("local", user_media_path, "1")

            # No file should be in the instance-wide storage before
            # execution of any tool.
            assert self.get_files_count(self.files_default_path) == 0

            # No file should be in user's plugged media before
            # execution of any tool.
            assert self.get_files_count(plugged_media.get("path")) == 0

            with self.dataset_populator.test_history() as history_id:
                self.run_tool(history_id)

                assert self.get_files_count(self.files_default_path) == 0
                assert self.get_files_count(plugged_media.get("path")) == 11

                # Assert content
                files = _get_datasets_files_in_path(plugged_media.get("path"))
                expected_content = [str(x) for x in range(1, 11)] + [TEST_INPUT_FILES_CONTENT]
                self.assert_content(files, expected_content)

                history_details = self._get(path="histories/" + history_id)
                datasets = json.loads(history_details.content)["state_ids"]["ok"]

                assert len(datasets) == 11

                data = {"purge": True}
                for dataset_id in datasets:
                    self._delete("histories/{}/contents/{}".format(history_id, dataset_id), data=data)

                files = _get_datasets_files_in_path(plugged_media.get("path"))

                # After purging, all the files in the user media should be deleted.
                assert len(files) == 0

    def test_anonymous_should_be_able_to_store_data_without_having_to_plug_a_media(self):
        with self._different_user("vahid@test.com"):
            # No file should be in the instance-wide storage before
            # execution of any tool.
            assert self.get_files_count(self.files_default_path) == 0

            # self.dataset_populator = DatasetPopulator(self.galaxy_interactor)
            with self.dataset_populator.test_history() as history_id:
                self.run_tool(history_id)

                assert self.get_files_count(self.files_default_path) == 11

                # Assert content
                files = _get_datasets_files_in_path(self.files_default_path)
                expected_content = [str(x) for x in range(1, 11)] + [TEST_INPUT_FILES_CONTENT]
                self.assert_content(files, expected_content)

                history_details = self._get(path="histories/" + history_id)
                datasets = json.loads(history_details.content)["state_ids"]["ok"]

                assert len(datasets) == 11

                data = {"purge": True}
                for dataset_id in datasets:
                    self._delete("histories/{}/contents/{}".format(history_id, dataset_id), data=data)

                files = _get_datasets_files_in_path(self.files_default_path)

                # After purging, all the files in the user media should be deleted.
                assert len(files) == 0
