namespace Lapis.Core;

public enum PlayerEvent
{
    Jump,
    Land,
    Fall,
    Respawn,
    PowerStroke,
    WeakStroke,
    CallBoat,
}

public enum PlayerMode
{
    Walk,
    Boat,
}

public enum PlayerAnim
{
    Idle,
    Walk,
    Row,
    Sit,
}

public struct PlayerInput
{
    /// <summary>Raw stick/keys, -1..1: right.</summary>
    public double MoveX;

    /// <summary>Raw stick/keys, -1..1: forward.</summary>
    public double MoveY;

    public bool Sprint;
    public bool Interact;

    /// <summary>Jump on foot, long stroke in the boat.</summary>
    public bool Jump;

    /// <summary>Camera yaw in radians; walking is camera-relative.</summary>
    public double CameraYaw;
}

public sealed class BoatState
{
    public double X;
    public double Z;
    public double Heading;
    public double Speed;

    /// <summary>0..1 position in the rowing cycle; 0 = catch.</summary>
    public double Stroke;

    public bool Rowing;
    public double Bob;

    /// <summary>0..1 how strongly a star current is carrying the boat right now.</summary>
    public double Current;
}
