import importlib.util
import subprocess
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


def load_grinder_ble_module():
    module_path = Path(__file__).parents[1] / "grinder-ble.py"
    spec = importlib.util.spec_from_file_location("grinder_ble_under_test", module_path)
    module = importlib.util.module_from_spec(spec)

    dependency_check = SimpleNamespace(returncode=0, stderr="")
    with patch.object(subprocess, "run", return_value=dependency_check):
        spec.loader.exec_module(module)

    return module


grinder_ble = load_grinder_ble_module()


class FlakyBleakClient:
    instances = []

    def __init__(self, address):
        self.address = address
        self.is_connected = False
        self.notifications = []
        self.__class__.instances.append(self)

    async def connect(self):
        if len(self.__class__.instances) < 3:
            raise RuntimeError("device rebooted")
        self.is_connected = True

    async def start_notify(self, characteristic, callback):
        self.notifications.append((characteristic, callback))


class UploadTool:
    last_instance = None

    def __init__(self):
        self.connected = False
        self.upload_started = False
        self.__class__.last_instance = self

    async def connect_to_device(
        self,
        _device_name,
        retry_until_connected=False,
        retry_delay=2.0,
    ):
        del retry_delay
        self.connected = retry_until_connected
        return self.connected

    async def upload_firmware(self, _firmware_path, _force_full):
        self.upload_started = True
        return True

    async def disconnect(self):
        self.connected = False

    def safe_print(self, _message):
        pass


class ConnectionRetryTests(unittest.IsolatedAsyncioTestCase):
    async def test_retries_connection_failures_until_the_device_connects(self):
        FlakyBleakClient.instances = []
        tool = grinder_ble.GrinderBLETool()

        async def find_device(_device_name):
            return "AA:BB:CC:DD:EE:FF"

        tool.find_device = find_device

        with patch.object(grinder_ble, "BleakClient", FlakyBleakClient):
            connected = await tool.connect_to_device(
                "GrindByWeight",
                retry_until_connected=True,
                retry_delay=0,
            )

        self.assertTrue(connected)
        self.assertTrue(tool.connected)
        self.assertEqual(3, len(FlakyBleakClient.instances))

    async def test_upload_command_waits_for_a_ble_connection(self):
        argv = [
            "grinder-ble.py",
            "upload",
            "firmware.bin",
            "--force-full",
        ]

        with (
            patch.object(grinder_ble, "GrinderBLETool", UploadTool),
            patch.object(sys, "argv", argv),
        ):
            result = await grinder_ble.main()

        self.assertNotEqual(1, result)
        self.assertTrue(UploadTool.last_instance.upload_started)


if __name__ == "__main__":
    unittest.main()
