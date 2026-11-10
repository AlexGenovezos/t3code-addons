import importlib.util
import sqlite3
import unittest
import tempfile
import json
import os
from datetime import datetime, timezone, timedelta
from pathlib import Path

spec = importlib.util.spec_from_file_location('activity', Path(__file__).resolve().parents[1] / 'activity-probe.py')
activity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(activity)


class ActivityTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        for table in ['runs', 'run_attempts', 'provider_turns', 'subagents', 'runtime_requests']:
            self.db.execute(f'CREATE TABLE orchestration_v2_projection_{table}(status TEXT)')
        self.db.executescript('''
CREATE TABLE orchestration_v2_effect_outbox(status TEXT);
CREATE TABLE orchestration_v2_projection_turn_items(thread_id TEXT,run_id TEXT,type TEXT,status TEXT);
CREATE INDEX orchestration_v2_projection_turn_items_shell_pending_idx ON orchestration_v2_projection_turn_items(thread_id,run_id) WHERE type IN ('command_execution','dynamic_tool','subagent') AND status NOT IN ('completed','interrupted','failed','cancelled');
CREATE TABLE orchestration_v2_projection_provider_threads(payload_json TEXT);
CREATE TABLE scheduled_tasks(enabled INTEGER,next_run_at TEXT);
CREATE TABLE orchestration_v2_events(sequence INTEGER PRIMARY KEY);
''')

    def tearDown(self):
        self.db.close()

    def test_idle_and_event_revision(self):
        self.assertTrue(activity.database_activity(self.db)['idle'])
        self.db.execute('INSERT INTO orchestration_v2_events VALUES (5)')
        self.assertEqual(activity.database_activity(self.db)['revision'], '5')

    def test_every_unfinished_run_status_and_unknown_status_block(self):
        for status in ['running', 'queued', 'preparing', 'starting', 'waiting', 'new_unknown_status']:
            self.db.execute('DELETE FROM orchestration_v2_projection_runs')
            self.db.execute('INSERT INTO orchestration_v2_projection_runs VALUES (?)', (status,))
            self.assertFalse(activity.database_activity(self.db)['idle'])

    def test_pending_input_and_background_work_block(self):
        self.db.execute("INSERT INTO orchestration_v2_projection_runtime_requests VALUES ('pending')")
        self.assertFalse(activity.database_activity(self.db)['idle'])
        self.db.execute('DELETE FROM orchestration_v2_projection_runtime_requests')
        self.db.execute("INSERT INTO orchestration_v2_projection_turn_items VALUES ('thread','run','command_execution','running')")
        self.assertFalse(activity.database_activity(self.db)['idle'])
        self.db.execute('DELETE FROM orchestration_v2_projection_turn_items')
        self.db.execute('INSERT INTO orchestration_v2_projection_provider_threads VALUES (?)', ('{"pendingBackgroundTasks":[{"id":"task"}]}',))
        self.assertFalse(activity.database_activity(self.db)['idle'])

    def test_finished_work_is_idle_and_nearby_schedules_block(self):
        self.db.execute("INSERT INTO orchestration_v2_projection_runs VALUES ('completed')")
        now = datetime.now(timezone.utc)
        self.db.execute('INSERT INTO scheduled_tasks VALUES (1,?)', ((now + timedelta(hours=1)).isoformat(),))
        self.assertTrue(activity.database_activity(self.db, now)['idle'])
        self.db.execute('INSERT INTO scheduled_tasks VALUES (1,?)', ((now + timedelta(minutes=3)).isoformat(),))
        self.assertFalse(activity.database_activity(self.db, now)['idle'])

    def test_probe_reads_current_server_database_without_modifying_it(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            (root / 'environment-id').write_text('test-environment')
            (root / 'server-runtime.json').write_text(json.dumps({'pid': os.getpid(), 'startedAt': 'now'}))
            self.db.commit()
            output = sqlite3.connect(root / 'statev2.sqlite')
            self.db.backup(output)
            output.close()
            before = (root / 'statev2.sqlite').read_bytes()
            result = activity.probe(root)
            self.assertTrue(result['idle'])
            self.assertEqual(result['environmentId'], 'test-environment')
            self.assertEqual((root / 'statev2.sqlite').read_bytes(), before)

    def test_missing_upstream_schema_does_not_report_idle(self):
        self.db.execute('DROP INDEX orchestration_v2_projection_turn_items_shell_pending_idx')
        with self.assertRaises(sqlite3.OperationalError):
            activity.database_activity(self.db)


if __name__ == '__main__':
    unittest.main()
