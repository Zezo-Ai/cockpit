import cockpit from "cockpit";
import QUnit, { skipWithPybridge } from "qunit-tests";
import { machines } from "./machines.js";

const dbus = cockpit.dbus(null, { bus: "internal" });
let configDir;

QUnit.module("machines.d parsing tests", {
    beforeEach: () => cockpit.spawn(["mkdir", "-p", configDir + "/cockpit/machines.d"]),
    afterEach: () => cockpit.spawn(["rm", "-rf", configDir + "/cockpit/machines.d"]),
    after: () => cockpit.spawn(["rm", "-r", configDir]),
});

/***
 * Tests for parsing on-disk JSON configuration
 */

async function machinesParseTest(assert, machines_defs, expectedProperty, mode = null) {
    for (const fname in machines_defs) {
        let path = fname;
        if (fname.indexOf('/') < 0)
            path = configDir + "/cockpit/machines.d/" + fname;
        await cockpit.file(path).replace(machines_defs[fname]);
        if (mode !== null)
            await cockpit.script(`chmod ${mode} ${path}`);
    }

    const reply = await dbus.call("/machines", "org.freedesktop.DBus.Properties", "Get",
                                  ["cockpit.Machines", "Machines"], { type: "ss" });
    assert.equal(reply[0].t, "a{sa{sv}}", "expected return type");
    assert.deepEqual(reply[0].v, expectedProperty, "expected property value");
}

QUnit.test("no machine definitions", async assert => machinesParseTest(assert, {}, {}));

QUnit.test("empty json", async assert => machinesParseTest(assert, { "01.json": "" }, {}));

QUnit.test("two definitions", async assert => machinesParseTest(
    assert,
    {
        "01.json": '{"green": {"visible": true, "address": "1.2.3.4"}, ' +
                ' "9.8.7.6": {"visible": false, "address": "9.8.7.6", "user": "admin"}}'
    },
    {
        green: {
            address: { t: "s", v: "1.2.3.4" },
            visible: { t: "b", v: true }
        },
        "9.8.7.6": {
            address: { t: "s", v: "9.8.7.6" },
            user: { t: "s", v: "admin" },
            visible: { t: "b", v: false }
        }
    })
);

QUnit.test("invalid json", async assert => machinesParseTest(assert, { "01.json": '{"green":' }, {}));

QUnit.test("no read permissions", async assert => machinesParseTest(assert, { "02.json": '{"green": {} }' }, {}, 0));

skipWithPybridge("invalid data types", async assert => machinesParseTest(assert, { "01.json": '{"green": []}' }, {}));

skipWithPybridge("merge several JSON files", async assert => machinesParseTest(
    assert,
    /* 99-webui.json changes a property in green, adds a
     * property to blue, and adds an entire new host yellow */
    {
        "01-green.json": '{"green": {"visible": true, "address": "1.2.3.4"}}',
        "02-blue.json": '{"blue": {"address": "9.8.7.6"}}',
        "09-webui.json": '{"green": {"visible": false}, ' +
                        ' "blue":  {"user": "joe"}, ' +
                        ' "yellow": {"address": "fe80::1", "user": "sue"}}'
    },
    {
        green: {
            address: { t: "s", v: "1.2.3.4" },
            visible: { t: "b", v: false }
        },
        blue: {
            address: { t: "s", v: "9.8.7.6" },
            user: { t: "s", v: "joe" },
        },
        yellow: {
            address: { t: "s", v: "fe80::1" },
            user: { t: "s", v: "sue" },
        }
    }
));

skipWithPybridge("merge JSON files with errors", async assert => machinesParseTest(
    assert,
    {
        "01-valid.json": '{"green": {"visible": true, "address": "1.2.3.4"}}',
        "02-syntax.json": '[a',
        "03-toptype.json": '["green"]',
        "04-toptype.json": '{"green": ["visible"]}',
        "05-valid.json": '{"blue": {"address": "fe80::1"}}',
        // goodprop should still be considered
        "06-proptype.json": '{"green": {"visible": [], "address": {"bar": null}, "goodprop": "yeah"}}',
        "07-valid.json": '{"green": {"user": "joe"}}',
        "08-empty.json": ''
    },
    {
        green: {
            address: { t: "s", v: "1.2.3.4" },
            visible: { t: "b", v: true },
            user: { t: "s", v: "joe" },
            goodprop: { t: "s", v: "yeah" },
        },
        blue: {
            address: { t: "s", v: "fe80::1" }
        }
    }
));

/***
 * Tests for Update()
 */

async function machinesUpdateTest(assert, origJson, host, props, expectedJson) {
    const f = configDir + "/cockpit/machines.d/99-webui.json";

    await cockpit.file(f).replace(origJson);
    const reply = await dbus.call("/machines", "cockpit.Machines", "Update",
                                  ["99-webui.json", host, props], { type: "ssa{sv}" });
    assert.deepEqual(reply, [], "no expected return value");
    const content = await cockpit.file(f, { syntax: JSON }).read();
    assert.deepEqual(content, expectedJson, "expected file content");
}

QUnit.test("no config files", async assert => machinesUpdateTest(
    assert,
    null,
    "green",
    { visible: cockpit.variant('b', true), address: cockpit.variant('s', "1.2.3.4") },
    { green: { address: "1.2.3.4", visible: true } }
));

QUnit.test("add host to existing map", async assert => machinesUpdateTest(
    assert,
    '{"green": {"visible": true, "address": "1.2.3.4"}}',
    "blue",
    { visible: cockpit.variant('b', false), address: cockpit.variant('s', "9.8.7.6") },
    {
        green: { address: "1.2.3.4", visible: true },
        blue: { address: "9.8.7.6", visible: false }
    }
));

QUnit.test("change bool host property", async assert => machinesUpdateTest(
    assert,
    '{"green": {"visible": true, "address": "1.2.3.4"}}',
    "green",
    { visible: cockpit.variant('b', false) },
    { green: { address: "1.2.3.4", visible: false } }
));

QUnit.test("change string host property", async assert => machinesUpdateTest(
    assert,
    '{"green": {"visible": true, "address": "1.2.3.4"}}',
    "green",
    { address: cockpit.variant('s', "fe80::1") },
    { green: { address: "fe80::1", visible: true } }
));

QUnit.test("add host property", async assert => machinesUpdateTest(
    assert,
    '{"green": {"visible": true, "address": "1.2.3.4"}}',
    "green",
    { color: cockpit.variant('s', "pitchblack") },
    { green: { address: "1.2.3.4", visible: true, color: "pitchblack" } }
));

QUnit.test("Update() only writes delta", async assert => {
    await cockpit.file(configDir + "/cockpit/machines.d/01-green.json")
            .replace('{"green": {"address": "1.2.3.4"}, "blue": {"address": "fe80::1"}}');
    return machinesUpdateTest(
        assert,
        null,
        "green",
        { color: cockpit.variant('s', "pitchblack") },
        { green: { color: "pitchblack" } });
});

QUnit.test("updating and existing delta file", async assert => {
    await cockpit.file(configDir + "/cockpit/machines.d/01-green.json")
            .replace('{"green": {"address": "1.2.3.4"}, "blue": {"address": "fe80::1"}}');

    return machinesUpdateTest(
        assert,
        '{"green": {"address": "9.8.7.6", "user": "joe"}}',
        "green",
        { color: cockpit.variant('s', "pitchblack") },
        { green: { address: "9.8.7.6", user: "joe", color: "pitchblack" } });
});

QUnit.test("colors.parse()", assert => {
    const colors = [
        ["#960064", "rgb(150, 0, 100)"],
        ["rgb(150, 0, 100)", "rgb(150, 0, 100)"],
        ["#ccc", "rgb(204, 204, 204)"],
    ];
    assert.expect(colors.length);
    colors.forEach(color => assert.equal(machines.colors.parse(color[0]), color[1], "parsed color " + color[0]));
});

/* The test cockpit-bridge gets started with temp $XDG_CONFIG_DIRS instead of defaulting to /etc/.
 * Read it from the bridge so that we can put our test files into it. */
const proxy = dbus.proxy("cockpit.Environment", "/environment");
proxy.wait(() => {
    configDir = proxy.Variables.XDG_CONFIG_DIRS;
    QUnit.start();
});
