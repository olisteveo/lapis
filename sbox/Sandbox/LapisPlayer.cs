// UNTESTED AGAINST THE s&box SDK. Written from the public s&box API as best known (Component,
// OnFixedUpdate, Input.AnalogMove/AnalogLook, Scene.Camera); not compiled. Expect small API-name
// fixes on first build.
using System;
using Lapis.Core;
using Sandbox;

namespace Lapis.Sandbox;

/// <summary>
/// Owns a Lapis.Core.PlayerController and is its only bridge to the engine: samples input, feeds the
/// controller at the fixed tick (so behaviour matches the browser build and the parity traces),
/// writes the result back to the GameObject, the boat and the camera.
/// </summary>
public sealed class LapisPlayer : Component
{
    /// <summary>World height (inches) of the sea surface; Lapis heights are relative to it.</summary>
    [Property] public float WaterLevel { get; set; }

    [Property] public GameObject? Boat { get; set; }
    [Property] public bool CanGlide { get; set; }
    [Property] public float CameraDistance { get; set; } = 5.5f;
    [Property] public float CameraHeight { get; set; } = 1.8f;
    [Property] public float LookSensitivity { get; set; } = 1f;

    public PlayerController Controller { get; private set; } = null!;
    public SceneWorld World { get; private set; } = null!;
    public string Prompt => Controller.Prompt;

    /// <summary>Re-raised core events, for audio and UI.</summary>
    public event Action<PlayerEvent>? PlayerEvent;

    private Angles _look;

    protected override void OnStart()
    {
        World = new SceneWorld(Scene, GameObject, WaterLevel);
        Controller = new PlayerController(World) { Colliders = World, Platforms = World, CanGlide = CanGlide };
        Controller.Event += e => PlayerEvent?.Invoke(e);

        var start = LapisSpace.FromWorld(WorldPosition, WaterLevel);
        if (Boat.IsValid())
        {
            var b = LapisSpace.FromWorld(Boat.WorldPosition, WaterLevel);
            Controller.PlaceBoat(b.X, b.Z, Boat.WorldRotation.Yaw() * Math.PI / 180.0);
        }
        Controller.Place(start.X, start.Z, WorldRotation.Yaw() * Math.PI / 180.0);
        _look = new Angles(15, WorldRotation.Yaw() + 180, 0);
    }

    protected override void OnUpdate()
    {
        // Look every frame so the camera stays smooth even between fixed ticks.
        _look += Input.AnalogLook * LookSensitivity;
        _look.pitch = Math.Clamp(_look.pitch, -60f, 75f);
        UpdateCamera();
    }

    protected override void OnFixedUpdate()
    {
        Controller.CanGlide = CanGlide;
        var move = Input.AnalogMove;
        var input = new PlayerInput
        {
            // s&box AnalogMove is x = forward, y = left; Lapis wants x = right, y = forward.
            MoveX = -move.y,
            MoveY = move.x,
            Sprint = Input.Down("Run"),
            // Down, not Pressed: the core does its own edge detection and also needs hold time (call the boat).
            Interact = Input.Down("use"),
            Jump = Input.Down("Jump"),
            CameraYaw = LapisSpace.CameraYawFromDegrees(_look.yaw),
        };
        Controller.Update(Time.Delta, input);

        WorldPosition = LapisSpace.ToWorld(Controller.Position, WaterLevel);
        WorldRotation = LapisSpace.HeadingToRotation(Controller.Heading);
        if (Boat.IsValid())
        {
            var b = Controller.Boat;
            Boat.WorldPosition = LapisSpace.ToWorld(b.X, b.Bob, b.Z, WaterLevel);
            Boat.WorldRotation = LapisSpace.HeadingToRotation(b.Heading);
        }
    }

    private void UpdateCamera()
    {
        var cam = Scene.Camera;
        if (cam is null || Controller is null) return;
        var rot = _look.ToRotation();
        var pivot = WorldPosition + Vector3.Up * CameraHeight * LapisSpace.UnitsPerMetre;
        var want = pivot - rot.Forward * CameraDistance * LapisSpace.UnitsPerMetre;
        // Pull the camera in front of walls instead of clipping through them.
        var tr = Scene.Trace.Ray(pivot, want).IgnoreGameObjectHierarchy(GameObject).Run();
        cam.WorldPosition = tr.Hit ? tr.HitPosition + tr.Normal * 4f : want;
        cam.WorldRotation = rot;
    }
}
