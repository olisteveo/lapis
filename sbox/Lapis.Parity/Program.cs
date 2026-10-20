using System.Text.Json;
using Lapis.Core;
using Lapis.Parity;

// Replays the TypeScript reference traces (sbox/parity/*.json, written by tools/parity/trace.ts)
// through the C# port and compares every step.
const double Tolerance = 1e-4;

var dir = args.Length > 0 ? args[0] : FindParityDir();
var files = Directory.GetFiles(dir, "*.json").OrderBy(f => f).ToArray();
if (files.Length == 0)
{
    Console.Error.WriteLine($"No traces in {dir}. Run: node --experimental-transform-types tools/parity/trace.ts");
    return 2;
}

var failures = 0;
foreach (var file in files)
{
    using var doc = JsonDocument.Parse(File.ReadAllText(file));
    var root = doc.RootElement;
    var name = root.GetProperty("name").GetString()!;
    var result = name == "night" ? RunNight(root) : name == "darkwater" ? RunDarkWater(root) : name == "squalls" ? RunSqualls(root) : name.StartsWith("survival-") ? RunSurvival(root) : RunPlayer(root);
    if (result.Divergence != null) failures++;
    var status = result.Divergence == null ? "PASS" : "FAIL";
    Console.WriteLine($"{status}  {name,-14} {result.Steps,5} steps  max err {result.MaxError:0.0e+0}");
    if (result.Divergence != null) Console.WriteLine($"      first divergence: {result.Divergence}");
}
Console.WriteLine(failures == 0 ? $"All {files.Length} scenarios match within {Tolerance:0e+0}." : $"{failures} of {files.Length} scenarios diverged.");
return failures == 0 ? 0 : 1;

static string FindParityDir()
{
    for (var d = new DirectoryInfo(AppContext.BaseDirectory); d != null; d = d.Parent)
    {
        var candidate = Path.Combine(d.FullName, "parity");
        if (File.Exists(Path.Combine(candidate, "night.json"))) return candidate;
        candidate = Path.Combine(d.FullName, "sbox", "parity");
        if (File.Exists(Path.Combine(candidate, "night.json"))) return candidate;
    }
    throw new DirectoryNotFoundException("Could not find sbox/parity; pass the directory as the first argument.");
}

static string Camel<T>(T value) where T : Enum
{
    var s = value.ToString();
    return char.ToLowerInvariant(s[0]) + s[1..];
}

static Result RunPlayer(JsonElement root)
{
    var dt = root.GetProperty("dt").GetDouble();
    var setup = root.GetProperty("setup");
    double[] Triple(string key) => setup.GetProperty(key).EnumerateArray().Select(e => e.GetDouble()).ToArray();

    var world = new TestWorld();
    var p = new PlayerController(world) { Colliders = world, Platforms = world, CanGlide = setup.GetProperty("canGlide").GetBoolean() };
    var boat = Triple("boat");
    var place = Triple("place");
    p.PlaceBoat(boat[0], boat[1], boat[2]);
    p.Place(place[0], place[1], place[2], place.Length > 3 ? place[3] : double.PositiveInfinity);
    var events = new List<string>();
    p.Event += e => events.Add(Camel(e));

    var check = new Checker();
    var steps = root.GetProperty("steps");
    var i = 0;
    foreach (var s in steps.EnumerateArray())
    {
        var inp = s.GetProperty("in");
        var input = new PlayerInput
        {
            MoveX = inp.GetProperty("moveX").GetDouble(),
            MoveY = inp.GetProperty("moveY").GetDouble(),
            Sprint = inp.GetProperty("sprint").GetBoolean(),
            Interact = inp.GetProperty("interact").GetBoolean(),
            Jump = inp.GetProperty("jump").GetBoolean(),
            CameraYaw = inp.GetProperty("cameraYaw").GetDouble(),
        };
        events.Clear();
        p.Update(dt, input);

        check.Step = i;
        check.Num("x", s, p.X);
        check.Num("y", s, p.Y);
        check.Num("z", s, p.Z);
        check.Num("heading", s, p.Heading);
        check.Num("speed", s, p.Speed);
        check.Num("vy", s, p.VerticalVelocity);
        check.Num("falling", s, p.Falling);
        check.Num("animRate", s, p.AnimRate);
        check.Str("mode", s, Camel(p.Mode));
        check.Str("anim", s, Camel(p.Anim));
        check.Str("prompt", s, p.Prompt);
        check.Bool("airborne", s, p.Airborne);
        var b = s.GetProperty("boat");
        check.Num("boat.x", b, p.Boat.X, "x");
        check.Num("boat.z", b, p.Boat.Z, "z");
        check.Num("boat.heading", b, p.Boat.Heading, "heading");
        check.Num("boat.speed", b, p.Boat.Speed, "speed");
        check.Num("boat.stroke", b, p.Boat.Stroke, "stroke");
        check.Num("boat.bob", b, p.Boat.Bob, "bob");
        check.Num("boat.current", b, p.Boat.Current, "current");
        check.Bool("boat.rowing", b, p.Boat.Rowing, "rowing");
        var expected = string.Join(",", s.GetProperty("events").EnumerateArray().Select(e => e.GetString()));
        check.Equal("events", expected, string.Join(",", events));
        i++;
    }
    return new Result(i, check.MaxError, check.Divergence);
}

static Result RunNight(JsonElement root)
{
    var night = new NightClock(root.GetProperty("length").GetDouble());
    var cues = new List<string>();
    night.Cue += c => cues.Add(Camel(c));
    var check = new Checker();
    var i = 0;
    foreach (var s in root.GetProperty("steps").EnumerateArray())
    {
        cues.Clear();
        if (s.GetProperty("reset").GetBoolean()) night.Reset();
        var rewind = s.GetProperty("rewind").GetDouble();
        if (rewind > 0) night.Rewind(rewind);
        night.Update(s.GetProperty("dt").GetDouble());
        check.Step = i;
        check.Num("progress", s, night.Progress);
        check.Str("phrase", s, night.Phrase);
        check.Equal("cues", string.Join(",", s.GetProperty("cues").EnumerateArray().Select(e => e.GetString())), string.Join(",", cues));
        i++;
    }
    return new Result(i, check.MaxError, check.Divergence);
}

static Result RunSurvival(JsonElement root)
{
    var t = root.GetProperty("mode").GetString() == "story" ? SurvivalTuning.Story : SurvivalTuning.Survival;
    var warmth = new Warmth();
    var light = new LightStore(t.WispCap);
    var rests = new RestReturns();
    var sources = new Sources();
    var check = new Checker();
    var i = 0;
    var now = 0.0;
    foreach (var s in root.GetProperty("steps").EnumerateArray())
    {
        var dt = s.GetProperty("dt").GetDouble();
        now += dt;
        var e = new Exposure(s.GetProperty("lit").GetDouble(), s.GetProperty("inWater").GetBoolean(), s.GetProperty("wind").GetDouble(), s.GetProperty("night").GetDouble(), s.GetProperty("dark").GetDouble(), s.GetProperty("rain").GetDouble(), s.GetProperty("glow").GetDouble());
        var collapsed = warmth.Update(dt, e, t);
        if (collapsed) warmth.Reset();
        light.Update(dt);
        if (i == 1200) light.Cap = t.LanternCap;
        var flare = i % 400 == 0 && light.Flare(t);
        var drawn = i % 300 < 150 ? sources.Draw(12.5, -3, now, dt, t.DrawRate) : 0;
        light.Gain(drawn + t.MoteRate * dt * 0.5);
        var rest = i % 500 == 0 ? rests.RestAt(i % 1500 == 0 ? 2 : 1) : 0;
        if (i == 2500) rests.Clear();
        check.Step = i;
        check.Num("warmth", s, warmth.Value);
        check.Equal("collapsed", s.GetProperty("collapsed").GetBoolean().ToString(), collapsed.ToString());
        check.Num("light", s, light.Value);
        check.Num("cap", s, light.Cap);
        check.Equal("ready", s.GetProperty("ready").GetBoolean().ToString(), light.Ready.ToString());
        check.Equal("flare", s.GetProperty("flare").GetBoolean().ToString(), flare.ToString());
        check.Num("drawn", s, drawn);
        check.Num("left", s, sources.Left(12.5, -3, now));
        check.Num("rest", s, rest);
        check.Num("streak", s, rests.Streak);
        i++;
    }
    return new Result(i, check.MaxError, check.Divergence);
}

static Result RunDarkWater(JsonElement root)
{
    var refuges = root.GetProperty("refuges").EnumerateArray()
        .Select(r => new Refuge(r.GetProperty("x").GetDouble(), r.GetProperty("z").GetDouble(), r.GetProperty("r").GetDouble())).ToList();
    var check = new Checker();
    var i = 0;
    foreach (var s in root.GetProperty("steps").EnumerateArray())
    {
        var mode = s.GetProperty("mode").GetString() == "story" ? SurvivalMode.Story : SurvivalMode.Survival;
        var reach = DarkWater.Reach(s.GetProperty("night").GetDouble(), mode);
        check.Step = i;
        check.Num("reach", s, reach);
        check.Num("dark", s, DarkWater.At(s.GetProperty("x").GetDouble(), s.GetProperty("z").GetDouble(), reach, refuges));
        check.Equal("wander", "null", double.IsInfinity(DarkWater.Reach(0.5, SurvivalMode.Wander)) ? "null" : "finite");
        i++;
    }
    return new Result(i, check.MaxError, check.Divergence);
}

static Result RunSqualls(JsonElement root)
{
    var sq = new SquallClock((uint)root.GetProperty("seed").GetInt32());
    var check = new Checker();
    var i = 0;
    foreach (var s in root.GetProperty("steps").EnumerateArray())
    {
        var entered = sq.Update(s.GetProperty("dt").GetDouble(), s.GetProperty("pressure").GetDouble(), s.GetProperty("enabled").GetBoolean());
        if (s.TryGetProperty("phase", out _))
        {
            check.Step = i;
            check.Str("phase", s, Camel(sq.Phase));
            var exp = s.GetProperty("entered");
            check.Equal("entered", exp.ValueKind == JsonValueKind.Null ? "" : exp.GetString()!, entered.HasValue ? Camel(entered.Value) : "");
            check.Num("intensity", s, sq.Intensity);
            check.Num("angle", s, sq.WindAngle);
        }
        i++;
    }
    return new Result(i, check.MaxError, check.Divergence);
}

record Result(int Steps, double MaxError, string? Divergence);

sealed class Checker
{
    private const double Tolerance = 1e-4;
    public int Step;
    public double MaxError;
    public string? Divergence;

    public void Num(string label, JsonElement obj, double actual, string? key = null)
    {
        var expected = obj.GetProperty(key ?? label).GetDouble();
        var err = Math.Abs(expected - actual);
        if (double.IsNaN(err)) err = double.PositiveInfinity;
        MaxError = Math.Max(MaxError, err);
        if (err > Tolerance) Fail(label, expected.ToString("R"), actual.ToString("R"));
    }

    public void Str(string label, JsonElement obj, string actual) => Equal(label, obj.GetProperty(label).GetString() ?? "", actual);

    public void Bool(string label, JsonElement obj, bool actual, string? key = null) =>
        Equal(label, obj.GetProperty(key ?? label).GetBoolean().ToString(), actual.ToString());

    public void Equal(string label, string expected, string actual)
    {
        if (expected != actual) Fail(label, $"\"{expected}\"", $"\"{actual}\"");
    }

    private void Fail(string label, string expected, string actual) =>
        Divergence ??= $"step {Step}: {label} expected {expected}, got {actual}";
}
