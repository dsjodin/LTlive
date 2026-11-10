"""Run: cd backend && python -m unittest tests.test_schematic_builder"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import config  # noqa: E402
from schematic_builder import build_schematic  # noqa: E402

FILES = {
    "routes.txt": "route_id,route_short_name,route_long_name,route_type,route_color\n"
                  "r1,1,,3,\nr2,2,,3,\nr9,99,,3,\n",
    "stops.txt": "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\n"
                 "P,Centrum,59.2740,15.2130,1,\n"
                 "Pa,Centrum,59.2740,15.2130,0,P\nPb,Centrum,59.2741,15.2132,0,P\n"
                 "A,Norr,59.2900,15.2130,0,\nB,Syd,59.2600,15.2130,0,\n"
                 "C,Vast,59.2740,15.1900,0,\nD,Ost,59.2740,15.2400,0,\n"
                 "D2,Ost,59.2742,15.2402,0,\nX,Annan,59.3000,15.3000,0,\n",
    "trips.txt": "trip_id,route_id,service_id,direction_id\n"
                 "t1,r1,s,0\nt2,r1,s,1\nt3,r2,s,0\nt4,r2,s,1\nt9,r9,s,0\n",
    "stop_times.txt": "trip_id,stop_id,stop_sequence\n"
                      "t1,A,1\nt1,Pa,2\nt1,B,3\n"
                      "t2,B,1\nt2,Pb,2\nt2,A,3\n"
                      "t3,C,1\nt3,Pa,2\nt3,D,3\n"
                      "t4,D2,1\nt4,Pb,2\nt4,C,3\n"
                      "t9,X,1\nt9,A,2\n",
}


class BuildSchematicTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        for name, body in FILES.items():
            with open(os.path.join(self.tmp.name, name), "w") as f:
                f.write(body)
        self._old = config.GTFS_DATA_DIR
        config.GTFS_DATA_DIR = self.tmp.name

    def tearDown(self):
        config.GTFS_DATA_DIR = self._old
        self.tmp.cleanup()

    def test_model(self):
        m = build_schematic(["1", "2"])
        self.assertEqual(list(m["lines"]), ["1", "2"])
        # Quays merged into parent, same-name stops merged, line 99 ignored
        self.assertEqual(sorted(m["nodes"]), ["A", "B", "C", "D", "P"])
        self.assertEqual(sorted(m["nodes"]["P"]["stop_ids"]), ["Pa", "Pb"])
        self.assertEqual(sorted(m["nodes"]["D"]["stop_ids"]), ["D", "D2"])
        self.assertEqual(len(m["edges"]), 4)
        for e in m["edges"]:
            self.assertTrue(e["lines"])
            self.assertIn(e["a"], m["nodes"])
            self.assertIn(e["b"], m["nodes"])
        for p in m["patterns"]:
            self.assertTrue(all(n in m["nodes"] for n in p["nodes"]))
        # Start layout is octilinear for this cross-shaped network
        pos = {k: (n["x"], n["y"]) for k, n in m["nodes"].items()}
        self.assertEqual(pos["A"][0], pos["P"][0])
        self.assertEqual(pos["C"][1], pos["P"][1])
        self.assertLess(pos["A"][1], pos["B"][1])
        self.assertEqual(len(set(pos.values())), len(pos))

    def test_no_lines(self):
        self.assertIsNone(build_schematic(["42"]))


if __name__ == "__main__":
    unittest.main()
